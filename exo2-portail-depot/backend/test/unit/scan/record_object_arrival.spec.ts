import type { DepositedFile } from '../../../src/domain/deposited_file';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
} from '../../../src/object_storage/object_storage';
import {
  OBJECT_ARRIVAL_LOG_CONTEXT,
  ObjectArrivalRecordingService,
  type ObjectArrivalOutcome,
} from '../../../src/scan/record_object_arrival';
import type { ScanJobPayload, ScanQueue } from '../../../src/scan/scan_queue';
import type { ObjectArrivalNotification } from '../../../src/scan/storage_event';
import type { Clock } from '../../../src/shared/clock';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';
import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { FakeDepositedFileRepository } from '../../helpers/fake_deposited_file_repository';
import { FakeExpectedDocumentRepository } from '../../helpers/fake_expected_document_repository';
import { FakeObjectStorage } from '../../helpers/fake_object_storage';
import type { ExpectedDocument } from '../../../src/domain/expected_document';
import type { NewActivityEvent } from '../../../src/domain/activity_event';
import {
  REFERENCE_NOW,
  add_minutes,
  build_deposited_file,
  build_expected_document,
} from '../../fixtures/domain_builders';

// L'ordre entre l'ecriture et l'enfilement est une garantie du service, pas un
// detail : un journal partage est le seul moyen de l'affirmer.
type RecordedInteraction = 'save_state' | 'enqueue_scan';

class InteractionOrderingDepositedFileRepository extends FakeDepositedFileRepository {
  constructor(private readonly interactions: RecordedInteraction[]) {
    super();
  }

  override async save_state(file: DepositedFile): Promise<void> {
    this.interactions.push('save_state');
    await super.save_state(file);
  }
}

class RecordingScanQueue implements ScanQueue {
  readonly enqueued_payloads: ScanJobPayload[] = [];

  constructor(private readonly interactions: RecordedInteraction[]) {}

  async enqueue_scan(payload: ScanJobPayload): Promise<void> {
    this.interactions.push('enqueue_scan');
    this.enqueued_payloads.push(payload);
  }
}

interface ObjectArrivalTestContext {
  service: ObjectArrivalRecordingService;
  deposited_files: FakeDepositedFileRepository;
  expected_documents: FakeExpectedDocumentRepository;
  activity_events: FakeActivityEventRepository;
  object_storage: FakeObjectStorage;
  scan_queue: RecordingScanQueue;
  logger: CapturingLogger;
  interactions: RecordedInteraction[];
}

function build_object_arrival_test_context(): ObjectArrivalTestContext {
  const interactions: RecordedInteraction[] = [];
  const deposited_files = new InteractionOrderingDepositedFileRepository(interactions);
  const expected_documents = new FakeExpectedDocumentRepository();
  const activity_events = new FakeActivityEventRepository();
  const object_storage = new FakeObjectStorage();
  const scan_queue = new RecordingScanQueue(interactions);
  const logger: CapturingLogger = build_capturing_logger();
  const clock: Clock = { now: (): Date => REFERENCE_NOW };

  // C'est le document attendu qui porte la demande : sans lui rien ne relie la
  // piece a un dossier, et aucun evenement ne peut etre inscrit.
  expected_documents.seed(build_expected_document());

  return {
    service: new ObjectArrivalRecordingService({
      deposited_files,
      expected_documents,
      activity_events,
      object_storage,
      scan_queue,
      clock,
      logger,
    }),
    deposited_files,
    expected_documents,
    activity_events,
    object_storage,
    scan_queue,
    logger,
    interactions,
  };
}

function build_arrival_notification(
  overrides: Partial<ObjectArrivalNotification> = {},
): ObjectArrivalNotification {
  return {
    bucket: QUARANTINE_BUCKET_NAME,
    object_key: 'request-1/expected-document-1/upload-1',
    size_bytes: 4096,
    ...overrides,
  };
}

describe('ObjectArrivalRecordingService', () => {
  it('ignore une notification venue d\'un autre bucket que la quarantaine, sans rien ecrire ni enfiler', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const file: DepositedFile = build_deposited_file({ status: 'clean', scanned_at: REFERENCE_NOW });
    context.deposited_files.seed(file);

    const outcome: ObjectArrivalOutcome = await context.service.record(
      build_arrival_notification({ bucket: VERIFIED_BUCKET_NAME, object_key: file.object_key }),
    );

    expect(outcome).toEqual({ kind: 'ignored_outside_quarantine' });
    expect(context.deposited_files.files.get(file.id)).toEqual(file);
    expect(context.interactions).toEqual([]);
    expect(context.object_storage.deleted_keys).toEqual([]);
  });

  it('supprime de la quarantaine un objet qui n\'appartient a aucune piece et journalise un avertissement', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const notification: ObjectArrivalNotification = build_arrival_notification({
      object_key: 'request-1/expected-document-1/objet-orphelin',
    });
    context.object_storage.put(
      QUARANTINE_BUCKET_NAME,
      notification.object_key,
      Buffer.from('des octets sans proprietaire'),
    );

    const outcome: ObjectArrivalOutcome = await context.service.record(notification);

    expect(outcome).toEqual({ kind: 'orphan_object_deleted' });
    expect(context.object_storage.deleted_keys).toEqual([
      { bucket: QUARANTINE_BUCKET_NAME, object_key: notification.object_key },
    ]);
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
    expect(context.interactions).toEqual([]);
    expect(context.logger.entries_at_level('warn')).toEqual([
      {
        level: 'warn',
        context: OBJECT_ARRIVAL_LOG_CONTEXT,
        message: 'objet orphelin supprime de la quarantaine',
        fields: { object_key: notification.object_key },
      },
    ]);
  });

  it('repasse la piece en pending_scan, inscrit la taille reelle lue sur la notification et date l\'arrivee', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const file: DepositedFile = build_deposited_file({
      status: 'pending_upload',
      actual_size_bytes: null,
      uploaded_at: null,
      scanned_at: null,
    });
    context.deposited_files.seed(file);

    const outcome: ObjectArrivalOutcome = await context.service.record(
      build_arrival_notification({ object_key: file.object_key, size_bytes: 8192 }),
    );

    expect(outcome).toEqual({ kind: 'queued_for_scan' });
    const file_after_arrival: DepositedFile | undefined = context.deposited_files.files.get(file.id);
    expect(file_after_arrival?.status).toBe('pending_scan');
    expect(file_after_arrival?.actual_size_bytes).toBe(8192);
    expect(file_after_arrival?.uploaded_at).toEqual(REFERENCE_NOW);
    expect(context.scan_queue.enqueued_payloads).toEqual([{ deposited_file_id: file.id }]);
  });

  it('remet le type detecte et la date de scan a zero : le verdict portait sur l\'objet precedent', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const file: DepositedFile = build_deposited_file({
      status: 'clean',
      detected_mime_type: 'application/pdf',
      scanned_at: add_minutes(REFERENCE_NOW, -30),
    });
    context.deposited_files.seed(file);

    await context.service.record(build_arrival_notification({ object_key: file.object_key }));

    const file_after_arrival: DepositedFile | undefined = context.deposited_files.files.get(file.id);
    expect(file_after_arrival?.status).toBe('pending_scan');
    expect(file_after_arrival?.detected_mime_type).toBeNull();
    expect(file_after_arrival?.scanned_at).toBeNull();
  });

  // Un scan enfile avant l'ecriture trouverait une piece encore en attente
  // d'upload et conclurait a tort a un objet absent.
  it('n\'enfile le scan qu\'apres avoir ecrit l\'etat de la piece', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const file: DepositedFile = build_deposited_file({ status: 'pending_upload' });
    context.deposited_files.seed(file);

    await context.service.record(build_arrival_notification({ object_key: file.object_key }));

    expect(context.interactions).toEqual(['save_state', 'enqueue_scan']);
  });

  it('ecarte l\'arrivee dont l\'emplacement vient d\'etre pris par une autre piece : la ligne et l\'objet partent, rien n\'est enfile', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const winning_file: DepositedFile = build_deposited_file({
      id: 'file-gagnante',
      status: 'pending_scan',
      object_key: 'request-1/expected-document-1/upload-gagnante',
    });
    const superseded_file: DepositedFile = build_deposited_file({
      id: 'file-perdante',
      status: 'pending_upload',
      object_key: 'request-1/expected-document-1/upload-perdante',
    });
    context.deposited_files.seed(winning_file, superseded_file);
    context.object_storage.put(
      QUARANTINE_BUCKET_NAME,
      superseded_file.object_key,
      Buffer.from('les octets de la perdante'),
    );

    const outcome: ObjectArrivalOutcome = await context.service.record(
      build_arrival_notification({ object_key: superseded_file.object_key }),
    );

    expect(outcome).toEqual({ kind: 'orphan_object_deleted' });
    expect(context.deposited_files.files.has(superseded_file.id)).toBe(false);
    expect(context.deposited_files.files.get(winning_file.id)).toEqual(winning_file);
    expect(context.object_storage.deleted_keys).toEqual([
      { bucket: QUARANTINE_BUCKET_NAME, object_key: superseded_file.object_key },
    ]);
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
    expect(context.scan_queue.enqueued_payloads).toEqual([]);
    expect(context.logger.entries_at_level('warn')).toEqual([
      {
        level: 'warn',
        context: OBJECT_ARRIVAL_LOG_CONTEXT,
        message: 'arrivee ecartee : l emplacement avait deja ete pris',
        fields: {
          deposited_file_id: superseded_file.id,
          expected_document_id: superseded_file.expected_document_id,
        },
      },
    ]);
  });

  it('journalise exactement une reception, au nom du client, rattachee a la demande du document attendu', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const expected_document: ExpectedDocument = build_expected_document();
    const file: DepositedFile = build_deposited_file({ status: 'pending_upload' });
    context.deposited_files.seed(file);

    await context.service.record(build_arrival_notification({ object_key: file.object_key }));

    expect(context.activity_events.recorded_events).toEqual<NewActivityEvent[]>([
      {
        deposit_request_id: expected_document.deposit_request_id,
        type: 'deposited_file_received',
        actor: { kind: 'client' },
        access_link_id: file.access_link_id,
        deposited_file_id: file.id,
        client_ip: null,
        occurred_at: REFERENCE_NOW,
      },
    ]);
  });

  it('ne journalise rien sur une notification venue d\'un autre bucket que la quarantaine', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const file: DepositedFile = build_deposited_file({ status: 'pending_upload' });
    context.deposited_files.seed(file);

    await context.service.record(
      build_arrival_notification({ bucket: VERIFIED_BUCKET_NAME, object_key: file.object_key }),
    );

    expect(context.activity_events.recorded_types()).toEqual([]);
  });

  // Un objet qui n'appartient a aucune piece n'a rien depose : l'inscrire ferait
  // un journal de receptions que personne n'a faites.
  it('ne journalise rien pour un objet orphelin, qu\'aucune piece ne reclame', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const notification: ObjectArrivalNotification = build_arrival_notification({
      object_key: 'request-1/expected-document-1/objet-orphelin',
    });
    context.object_storage.put(
      QUARANTINE_BUCKET_NAME,
      notification.object_key,
      Buffer.from('des octets sans proprietaire'),
    );

    await context.service.record(notification);

    expect(context.activity_events.recorded_types()).toEqual([]);
  });

  it('ne journalise rien pour l\'arrivee ecartee dont l\'emplacement avait deja ete pris', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const winning_file: DepositedFile = build_deposited_file({
      id: 'file-gagnante',
      status: 'pending_scan',
      object_key: 'request-1/expected-document-1/upload-gagnante',
    });
    const superseded_file: DepositedFile = build_deposited_file({
      id: 'file-perdante',
      status: 'pending_upload',
      object_key: 'request-1/expected-document-1/upload-perdante',
    });
    context.deposited_files.seed(winning_file, superseded_file);
    context.object_storage.put(
      QUARANTINE_BUCKET_NAME,
      superseded_file.object_key,
      Buffer.from('les octets de la perdante'),
    );

    await context.service.record(
      build_arrival_notification({ object_key: superseded_file.object_key }),
    );

    expect(context.activity_events.recorded_types()).toEqual([]);
  });

  // Le journal est une trace, pas une condition du depot : un document attendu
  // introuvable ne doit pas priver la piece de son scan antiviral.
  it('n\'echoue pas et enfile quand meme le scan quand le document attendu reste introuvable', async () => {
    const context: ObjectArrivalTestContext = build_object_arrival_test_context();
    const file: DepositedFile = build_deposited_file({
      status: 'pending_upload',
      expected_document_id: 'expected-document-disparu',
    });
    context.deposited_files.seed(file);

    const outcome: ObjectArrivalOutcome = await context.service.record(
      build_arrival_notification({ object_key: file.object_key }),
    );

    expect(outcome).toEqual({ kind: 'queued_for_scan' });
    expect(context.activity_events.recorded_types()).toEqual([]);
    expect(context.scan_queue.enqueued_payloads).toEqual([{ deposited_file_id: file.id }]);
  });
});
