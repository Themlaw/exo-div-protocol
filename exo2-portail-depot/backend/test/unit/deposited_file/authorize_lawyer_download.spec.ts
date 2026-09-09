import {
  LawyerDownloadAuthorizationService,
  PRESIGNED_DOWNLOAD_LIFETIME_SECONDS,
  type LawyerDownloadOutcome,
} from '../../../src/deposited_file/authorize_lawyer_download';
import type { DepositedFile, DepositedFileStatus } from '../../../src/domain/deposited_file';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
} from '../../../src/object_storage/object_storage';
import type { Clock } from '../../../src/shared/clock';
import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { FakeObjectStorage } from '../../helpers/fake_object_storage';
import { REFERENCE_NOW, build_deposited_file } from '../../fixtures/domain_builders';

const OWNER_USER_ID = 'lawyer-1';
const DEPOSIT_REQUEST_ID = 'request-1';

interface DownloadHarness {
  activity_events: FakeActivityEventRepository;
  object_storage: FakeObjectStorage;
  authorize: (deposited_file_id: string) => Promise<LawyerDownloadOutcome>;
}

// Le depot appartient a `OWNER_USER_ID` et a personne d'autre : le double rend
// `null` des que le proprietaire ne correspond pas, exactement comme la requete
// SQL qui porte l'appartenance en predicat.
function build_download_harness(owned_file: DepositedFile | null): DownloadHarness {
  const activity_events = new FakeActivityEventRepository();
  const object_storage = new FakeObjectStorage();
  const clock: Clock = { now: (): Date => REFERENCE_NOW };

  const service = new LawyerDownloadAuthorizationService({
    deposited_files: {
      find_for_owner: async (
        deposited_file_id: string,
        owner_user_id: string,
      ): Promise<{ file: DepositedFile; deposit_request_id: string } | null> =>
        owned_file !== null &&
        owned_file.id === deposited_file_id &&
        owner_user_id === OWNER_USER_ID
          ? { file: owned_file, deposit_request_id: DEPOSIT_REQUEST_ID }
          : null,
    },
    object_storage,
    activity_events,
    clock,
  });

  return {
    activity_events,
    object_storage,
    authorize: (deposited_file_id: string): Promise<LawyerDownloadOutcome> =>
      service.authorize({
        deposited_file_id,
        deposit_request_id: DEPOSIT_REQUEST_ID,
        owner_user_id: OWNER_USER_ID,
      }),
  };
}

describe('autorisation de telechargement par l avocat', () => {
  it('rend un ticket presigne pour une piece saine de son dossier', async () => {
    const file: DepositedFile = build_deposited_file({ status: 'clean' });
    const harness: DownloadHarness = build_download_harness(file);

    const outcome: LawyerDownloadOutcome = await harness.authorize(file.id);

    expect(outcome.kind).toBe('authorized');
    expect(outcome).toMatchObject({
      ticket: {
        expires_at: new Date(
          REFERENCE_NOW.getTime() + PRESIGNED_DOWNLOAD_LIFETIME_SECONDS * 1000,
        ),
      },
    });
  });

  // Une piece saine a ete PROMUE : viser la quarantaine signerait une URL vers
  // un objet qui n'y est plus, et le premier telechargement rendrait 404 sans
  // qu'aucun test ne l'ait vu.
  it('signe sur le bucket verifie, jamais sur la quarantaine', async () => {
    const file: DepositedFile = build_deposited_file({ status: 'clean' });
    const harness: DownloadHarness = build_download_harness(file);

    await harness.authorize(file.id);

    expect(harness.object_storage.presigned_download_requests).toEqual([
      {
        bucket: VERIFIED_BUCKET_NAME,
        object_key: file.object_key,
        display_filename: file.display_filename,
        lifetime_seconds: PRESIGNED_DOWNLOAD_LIFETIME_SECONDS,
        issued_at: REFERENCE_NOW,
      },
    ]);
    expect(harness.object_storage.presigned_download_requests[0]?.bucket).not.toBe(
      QUARANTINE_BUCKET_NAME,
    );
  });

  // Le nom voyage jusqu'au Content-Disposition signe : le perdre ferait
  // arriver la piece nommee comme un identifiant technique.
  it("porte le nom d'affichage de la piece dans la demande de signature", async () => {
    const file: DepositedFile = build_deposited_file({
      status: 'clean',
      display_filename: 'acte_de_deces.pdf',
    });
    const harness: DownloadHarness = build_download_harness(file);

    await harness.authorize(file.id);

    expect(harness.object_storage.presigned_download_requests[0]?.display_filename).toBe(
      'acte_de_deces.pdf',
    );
  });

  const NON_DOWNLOADABLE_STATUSES: readonly DepositedFileStatus[] = [
    'pending_upload',
    'pending_scan',
    'infected',
    'rejected',
  ];

  // `clean` est le SEUL statut telechargeable, et la liste est parcourue en
  // entier : ajouter un statut demain sans decider de son sort fera echouer ce
  // test plutot que d'ouvrir un telechargement par defaut.
  it.each(NON_DOWNLOADABLE_STATUSES)("refuse une piece '%s' et ne signe rien", async (status) => {
    const file: DepositedFile = build_deposited_file({ status });
    const harness: DownloadHarness = build_download_harness(file);

    const outcome: LawyerDownloadOutcome = await harness.authorize(file.id);

    expect(outcome).toEqual({ kind: 'file_not_downloadable', status });
    expect(harness.object_storage.presigned_download_requests).toEqual([]);
  });

  // « Pas a vous » et « n'existe pas » se repondent de la meme facon : sinon
  // l'identifiant d'une piece devient un oracle d'existence pour un confrere.
  it("refuse la piece d'un confrere avec le refus d'une piece inexistante", async () => {
    const foreign_file: DepositedFile = build_deposited_file({ status: 'clean' });
    const owns_nothing: DownloadHarness = build_download_harness(null);

    const on_foreign_file: LawyerDownloadOutcome = await owns_nothing.authorize(foreign_file.id);
    const on_unknown_file: LawyerDownloadOutcome = await owns_nothing.authorize(
      'file-qui-n-existe-pas',
    );

    expect(on_foreign_file).toEqual({ kind: 'unknown_file' });
    expect(on_foreign_file).toEqual(on_unknown_file);
  });

  // On journalise l'EMISSION DU TICKET, pas le transfert des octets : celui-ci
  // se passe entre le navigateur et le stockage, et nous ne l'observons pas.
  it('journalise le telechargement au nom de l avocat', async () => {
    const file: DepositedFile = build_deposited_file({ status: 'clean' });
    const harness: DownloadHarness = build_download_harness(file);

    await harness.authorize(file.id);

    expect(harness.activity_events.recorded_events).toEqual([
      {
        deposit_request_id: DEPOSIT_REQUEST_ID,
        type: 'deposited_file_downloaded',
        actor: { kind: 'lawyer', user_id: OWNER_USER_ID },
        access_link_id: file.access_link_id,
        deposited_file_id: file.id,
        client_ip: null,
        occurred_at: REFERENCE_NOW,
      },
    ]);
  });

  it('ne journalise rien quand le telechargement est refuse', async () => {
    const infected: DepositedFile = build_deposited_file({ status: 'infected' });
    const harness: DownloadHarness = build_download_harness(infected);
    const owns_nothing: DownloadHarness = build_download_harness(null);

    await harness.authorize(infected.id);
    await owns_nothing.authorize(infected.id);

    expect(harness.activity_events.recorded_events).toEqual([]);
    expect(owns_nothing.activity_events.recorded_events).toEqual([]);
  });

  // Le chemin porte la demande ET la piece : sans ce rapprochement, l'avocat
  // telechargerait une piece de son dossier A en passant par l'URL du dossier
  // B, et le journal l'ecrirait sous la mauvaise demande.
  it('refuse une piece qui ne vit pas dans la demande du chemin', async () => {
    const file: DepositedFile = build_deposited_file({ status: 'clean' });
    const activity_events = new FakeActivityEventRepository();
    const object_storage = new FakeObjectStorage();
    const service = new LawyerDownloadAuthorizationService({
      deposited_files: {
        find_for_owner: async (): Promise<{
          file: DepositedFile;
          deposit_request_id: string;
        } | null> => ({ file, deposit_request_id: 'une-autre-demande' }),
      },
      object_storage,
      activity_events,
      clock: { now: (): Date => REFERENCE_NOW },
    });

    const outcome: LawyerDownloadOutcome = await service.authorize({
      deposited_file_id: file.id,
      deposit_request_id: DEPOSIT_REQUEST_ID,
      owner_user_id: OWNER_USER_ID,
    });

    expect(outcome).toEqual({ kind: 'unknown_file' });
    expect(object_storage.presigned_download_requests).toEqual([]);
  });
});
