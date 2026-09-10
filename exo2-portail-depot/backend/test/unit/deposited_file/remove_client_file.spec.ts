import type { AccessLink } from '../../../src/domain/access_link';
import type { DepositedFile } from '../../../src/domain/deposited_file';
import type { DepositRequestStatus } from '../../../src/domain/deposit_request_status';
import type { ClientDepositRequestView } from '../../../src/deposit/deposit_request_repository';
import {
  ClientFileRemovalService,
  type ClientFileRemovalOutcome,
} from '../../../src/deposited_file/remove_client_file';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
} from '../../../src/object_storage/object_storage';
import type { Clock } from '../../../src/shared/clock';
import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { FakeDepositRequestLifecycle } from '../../helpers/fake_deposit_request_lifecycle';
import { FakeDepositRequestRepository } from '../../helpers/fake_deposit_request_repository';
import { FakeDepositedFileRepository } from '../../helpers/fake_deposited_file_repository';
import { FakeObjectStorage } from '../../helpers/fake_object_storage';
import {
  REFERENCE_NOW,
  build_access_link,
  build_deposited_file,
} from '../../fixtures/domain_builders';

const ACCESS_LINK: AccessLink = build_access_link();

// Le double partage ne rend pas la vue client, et c'est voulu : elle n'est le
// sujet d'aucun de ses autres usages. Le retrait, lui, y lit le STATUT de la
// demande — c'est lui qui dit si les pieces sont encore mobiles — donc ce test
// la derive du statut seme, plutot que d'ouvrir le double partage a tous.
class StatusOnlyDepositRequestRepository extends FakeDepositRequestRepository {
  override async find_client_view(
    deposit_request_id: string,
  ): Promise<ClientDepositRequestView | null> {
    const status: DepositRequestStatus | undefined = this.statuses.get(deposit_request_id);
    return status === undefined
      ? null
      : { title: 'Dossier de succession', status, expected_documents: [] };
  }
}

interface RemovalHarness {
  service: ClientFileRemovalService;
  deposit_request_lifecycle: FakeDepositRequestLifecycle;
  deposited_files: FakeDepositedFileRepository;
  activity_events: FakeActivityEventRepository;
  object_storage: FakeObjectStorage;
  remove: (deposited_file_id: string) => Promise<ClientFileRemovalOutcome>;
}

function build_removal_harness(deposit_request_status: DepositRequestStatus): RemovalHarness {
  const deposit_requests = new StatusOnlyDepositRequestRepository();
  const deposited_files = new FakeDepositedFileRepository();
  const activity_events = new FakeActivityEventRepository();
  const deposit_request_lifecycle = new FakeDepositRequestLifecycle();
  const object_storage = new FakeObjectStorage();
  const clock: Clock = { now: (): Date => REFERENCE_NOW };

  deposit_requests.seed(ACCESS_LINK.deposit_request_id, deposit_request_status);

  const service = new ClientFileRemovalService({
    deposit_requests,
    deposited_files,
    object_storage,
    activity_events,
    deposit_request_lifecycle,
    clock,
  });

  return {
    service,
    deposit_request_lifecycle,
    deposited_files,
    activity_events,
    object_storage,
    remove: (deposited_file_id: string): Promise<ClientFileRemovalOutcome> =>
      service.remove({ access_link: ACCESS_LINK, deposited_file_id }),
  };
}

function seed_stored_file(harness: RemovalHarness, file: DepositedFile): void {
  harness.deposited_files.seed(file);
  harness.object_storage.put(QUARANTINE_BUCKET_NAME, file.object_key, Buffer.alloc(16));
}

describe('retrait d une piece par le client', () => {
  // La piece saine OCCUPAIT un emplacement au titre de la completude : son
  // depart rouvre la demande, sinon un dossier resterait complet sans l'etre.
  it('signale la perte de completude au retrait d une piece saine', async () => {
    const harness: RemovalHarness = build_removal_harness('incomplete');
    seed_stored_file(harness, build_deposited_file({ status: 'clean' }));

    await expect(harness.remove('file-1')).resolves.toEqual({ kind: 'removed' });

    expect(harness.deposit_request_lifecycle.recorded_pipeline_events).toEqual([
      {
        deposit_request_id: ACCESS_LINK.deposit_request_id,
        event: 'expected_document_became_not_clean',
      },
    ]);
  });

  // Retirer une piece infectee ou refusee ne retire rien qui comptait : le
  // signaler ferait repasser en `incomplete` une demande que rien n'a degradee.
  it.each(['infected', 'rejected', 'pending_scan'] as const)(
    'ne signale rien au retrait d une piece %s',
    async (status) => {
      const harness: RemovalHarness = build_removal_harness('incomplete');
      seed_stored_file(harness, build_deposited_file({ status }));

      await expect(harness.remove('file-1')).resolves.toEqual({ kind: 'removed' });

      expect(harness.deposit_request_lifecycle.applied_events).toEqual([]);
    },
  );

  // Le GEL : a partir de `processing`, la demande appartient au dossier de
  // l'avocat, et retirer une piece changerait sous ses yeux ce qu'il examine.
  it.each(['processing', 'validated', 'blocked', 'expired_incomplete'] as const)(
    'refuse le retrait sur une demande gelee en %s, et ne signale rien',
    async (deposit_request_status) => {
      const harness: RemovalHarness = build_removal_harness(deposit_request_status);
      const file: DepositedFile = build_deposited_file({ status: 'clean' });
      seed_stored_file(harness, file);

      await expect(harness.remove(file.id)).resolves.toEqual({
        kind: 'deposit_request_is_frozen',
      });

      expect(harness.deposit_request_lifecycle.applied_events).toEqual([]);
      expect(harness.activity_events.recorded_types()).toEqual([]);
      expect(await harness.deposited_files.find_by_id(file.id)).not.toBeNull();
      expect(harness.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([file.object_key]);
    },
  );

  // Une piece qui n'est pas de ce lien-la n'est meme pas rendue : rien n'est
  // efface, et rien n'est signale.
  it('ne signale rien quand la piece visee est introuvable', async () => {
    const harness: RemovalHarness = build_removal_harness('incomplete');

    await expect(harness.remove('piece-inconnue')).resolves.toEqual({ kind: 'unknown_file' });

    expect(harness.deposit_request_lifecycle.applied_events).toEqual([]);
  });

  // L'objet quitte reellement les deux buckets : rien ne dit lequel le porte a
  // cet instant, et une suppression partielle laisserait un fichier appartenant
  // a un dossier qu'on croit vide.
  it('efface la ligne, journalise le retrait et vide les deux buckets', async () => {
    const harness: RemovalHarness = build_removal_harness('incomplete');
    const file: DepositedFile = build_deposited_file({ status: 'clean' });
    harness.deposited_files.seed(file);
    harness.object_storage.put(VERIFIED_BUCKET_NAME, file.object_key, Buffer.alloc(16));

    await harness.remove(file.id);

    expect(await harness.deposited_files.find_by_id(file.id)).toBeNull();
    expect(harness.activity_events.recorded_types()).toEqual(['deposited_file_removed']);
    expect(harness.object_storage.keys_of(VERIFIED_BUCKET_NAME)).toEqual([]);
    expect(harness.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
  });
});
