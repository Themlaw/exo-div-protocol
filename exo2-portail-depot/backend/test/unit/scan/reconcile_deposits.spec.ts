import type { Clock } from '../../../src/shared/clock';
import type { DepositedFile } from '../../../src/domain/deposited_file';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
} from '../../../src/object_storage/object_storage';
import { ObjectArrivalRecordingService } from '../../../src/scan/record_object_arrival';
import type { ScanJobPayload, ScanQueue } from '../../../src/scan/scan_queue';
import {
  DepositReconciliationService,
  SCAN_OVERDUE_AFTER_MINUTES,
  UPLOAD_RESERVATION_GRACE_MINUTES,
  type ReconciliationReport,
} from '../../../src/scan/reconcile_deposits';
import { FakeDepositedFileRepository } from '../../helpers/fake_deposited_file_repository';
import { FakeObjectStorage } from '../../helpers/fake_object_storage';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';
import { REFERENCE_NOW, add_minutes, build_deposited_file } from '../../fixtures/domain_builders';

class RecordingScanQueue implements ScanQueue {
  readonly enqueued_payloads: ScanJobPayload[] = [];

  async enqueue_scan(payload: ScanJobPayload): Promise<void> {
    this.enqueued_payloads.push(payload);
  }
}

interface ReconciliationHarness {
  deposited_files: FakeDepositedFileRepository;
  object_storage: FakeObjectStorage;
  scan_queue: RecordingScanQueue;
  logger: CapturingLogger;
  reconcile: () => Promise<ReconciliationReport>;
}

// Le vrai enregistreur d'arrivee, et non un double : la reconciliation delegue
// justement pour ne pas reimplementer cette decision, et un double la
// reimplementerait dans le test.
function build_reconciliation_harness(now: Date = REFERENCE_NOW): ReconciliationHarness {
  const deposited_files = new FakeDepositedFileRepository();
  const object_storage = new FakeObjectStorage();
  const scan_queue = new RecordingScanQueue();
  const logger: CapturingLogger = build_capturing_logger();
  const clock: Clock = { now: (): Date => now };

  const object_arrivals = new ObjectArrivalRecordingService({
    deposited_files,
    object_storage,
    scan_queue,
    clock,
    logger,
  });

  const reconciler = new DepositReconciliationService({
    deposited_files,
    object_storage,
    object_arrivals,
    scan_queue,
    clock,
    logger,
  });

  return {
    deposited_files,
    object_storage,
    scan_queue,
    logger,
    reconcile: (): Promise<ReconciliationReport> => reconciler.reconcile(),
  };
}

describe('reconciliation des depots', () => {
  describe('arrivees manquees', () => {
    it("rattrape une piece restee en attente d'upload alors que son objet est arrive", async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const reservation: DepositedFile = build_deposited_file({
        status: 'pending_upload',
        detected_mime_type: null,
        actual_size_bytes: null,
        uploaded_at: null,
        created_at: add_minutes(REFERENCE_NOW, -5),
      });
      harness.deposited_files.seed(reservation);
      harness.object_storage.put(
        QUARANTINE_BUCKET_NAME,
        reservation.object_key,
        Buffer.alloc(4096),
      );

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.missed_arrivals_recorded).toBe(1);
      expect(harness.deposited_files.files.get(reservation.id)).toMatchObject({
        status: 'pending_scan',
        actual_size_bytes: 4096,
        uploaded_at: REFERENCE_NOW,
      });
      expect(harness.scan_queue.enqueued_payloads).toEqual([
        { deposited_file_id: reservation.id },
      ]);
    });

    it("ne ramasse pas l'objet d'une arrivee qu'elle vient de rattraper", async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const reservation: DepositedFile = build_deposited_file({
        status: 'pending_upload',
        uploaded_at: null,
        created_at: add_minutes(REFERENCE_NOW, -5),
      });
      harness.deposited_files.seed(reservation);
      harness.object_storage.put(QUARANTINE_BUCKET_NAME, reservation.object_key, Buffer.alloc(10));

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.orphan_objects_collected).toBe(0);
      expect(harness.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([
        reservation.object_key,
      ]);
    });
  });

  describe('reservations abandonnees', () => {
    it('efface une reservation dont le presigned a expire sans qu aucun objet n arrive', async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const abandoned: DepositedFile = build_deposited_file({
        status: 'pending_upload',
        uploaded_at: null,
        created_at: add_minutes(REFERENCE_NOW, -(UPLOAD_RESERVATION_GRACE_MINUTES + 1)),
      });
      harness.deposited_files.seed(abandoned);

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.abandoned_reservations_discarded).toBe(1);
      expect(harness.deposited_files.files.has(abandoned.id)).toBe(false);
    });

    // Le point le plus dangereux du balayage : effacer la reservation d'un
    // client dont le transfert est en cours lui ferait perdre son depot sans
    // qu'il le sache.
    it('laisse intacte une reservation encore dans sa fenetre de transfert', async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const in_flight: DepositedFile = build_deposited_file({
        status: 'pending_upload',
        uploaded_at: null,
        created_at: add_minutes(REFERENCE_NOW, -(UPLOAD_RESERVATION_GRACE_MINUTES - 1)),
      });
      harness.deposited_files.seed(in_flight);

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.abandoned_reservations_discarded).toBe(0);
      expect(harness.deposited_files.files.get(in_flight.id)).toMatchObject({
        status: 'pending_upload',
      });
    });
  });

  describe('scans en retard', () => {
    it('reenfile une piece en attente de scan depuis trop longtemps', async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const overdue: DepositedFile = build_deposited_file({
        status: 'pending_scan',
        uploaded_at: add_minutes(REFERENCE_NOW, -(SCAN_OVERDUE_AFTER_MINUTES + 1)),
      });
      harness.deposited_files.seed(overdue);
      harness.object_storage.put(QUARANTINE_BUCKET_NAME, overdue.object_key, Buffer.alloc(10));

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.overdue_scans_requeued).toBe(1);
      expect(harness.scan_queue.enqueued_payloads).toEqual([{ deposited_file_id: overdue.id }]);
      expect(harness.logger.entries_at_level('warn')).toContainEqual(
        expect.objectContaining({ message: 'scans en retard reenfiles' }),
      );
    });

    it('laisse tranquille un scan encore dans son delai normal', async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const recent: DepositedFile = build_deposited_file({
        status: 'pending_scan',
        uploaded_at: add_minutes(REFERENCE_NOW, -(SCAN_OVERDUE_AFTER_MINUTES - 1)),
      });
      harness.deposited_files.seed(recent);
      harness.object_storage.put(QUARANTINE_BUCKET_NAME, recent.object_key, Buffer.alloc(10));

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.overdue_scans_requeued).toBe(0);
      expect(harness.scan_queue.enqueued_payloads).toEqual([]);
    });

    it("n'ecrit rien sur la piece qu'elle reenfile", async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const overdue: DepositedFile = build_deposited_file({
        status: 'pending_scan',
        uploaded_at: add_minutes(REFERENCE_NOW, -60),
      });
      harness.deposited_files.seed(overdue);
      harness.object_storage.put(QUARANTINE_BUCKET_NAME, overdue.object_key, Buffer.alloc(10));

      await harness.reconcile();

      expect(harness.deposited_files.files.get(overdue.id)).toEqual(overdue);
    });
  });

  describe('objets de quarantaine', () => {
    it('supprime un objet que plus aucune piece ne reclame', async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      harness.object_storage.put(
        QUARANTINE_BUCKET_NAME,
        'request-1/expected-document-9/upload-orpheline',
        Buffer.alloc(10),
      );

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.orphan_objects_collected).toBe(1);
      expect(harness.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
    });

    // Le reste d'une promotion interrompue : la piece est saine et son objet
    // vit desormais dans le bucket verifie, mais la copie de quarantaine est
    // restee.
    it('supprime la copie de quarantaine d une piece deja promue', async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const promoted: DepositedFile = build_deposited_file({
        status: 'clean',
        scanned_at: REFERENCE_NOW,
      });
      harness.deposited_files.seed(promoted);
      harness.object_storage.put(QUARANTINE_BUCKET_NAME, promoted.object_key, Buffer.alloc(10));
      harness.object_storage.put(VERIFIED_BUCKET_NAME, promoted.object_key, Buffer.alloc(10));

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.orphan_objects_collected).toBe(1);
      expect(harness.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
      expect(harness.object_storage.keys_of(VERIFIED_BUCKET_NAME)).toEqual([promoted.object_key]);
    });

    it('supprime la copie de quarantaine d une piece refusee', async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const rejected: DepositedFile = build_deposited_file({
        status: 'rejected',
        scanned_at: REFERENCE_NOW,
      });
      harness.deposited_files.seed(rejected);
      harness.object_storage.put(QUARANTINE_BUCKET_NAME, rejected.object_key, Buffer.alloc(10));

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.orphan_objects_collected).toBe(1);
      expect(harness.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
    });

    // Sans cette garde, le balayage detruirait exactement les objets que le
    // travailleur s'apprete a lire.
    it("ne touche pas a l'objet d'une piece qui attend son scan", async () => {
      const harness: ReconciliationHarness = build_reconciliation_harness();
      const waiting: DepositedFile = build_deposited_file({ status: 'pending_scan' });
      harness.deposited_files.seed(waiting);
      harness.object_storage.put(QUARANTINE_BUCKET_NAME, waiting.object_key, Buffer.alloc(10));

      const report: ReconciliationReport = await harness.reconcile();

      expect(report.orphan_objects_collected).toBe(0);
      expect(harness.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([
        waiting.object_key,
      ]);
    });
  });

  // Le balayage tourne toutes les quinze minutes pour toujours : une passe qui
  // referait le travail de la precedente enfilerait sans fin des scans deja
  // faits.
  it('ne refait rien lors d une seconde passe consecutive', async () => {
    const harness: ReconciliationHarness = build_reconciliation_harness();
    harness.deposited_files.seed(
      build_deposited_file({
        id: 'file-abandonnee',
        expected_document_id: 'expected-document-1',
        object_key: 'request-1/expected-document-1/upload-abandonnee',
        status: 'pending_upload',
        uploaded_at: null,
        created_at: add_minutes(REFERENCE_NOW, -(UPLOAD_RESERVATION_GRACE_MINUTES + 1)),
      }),
      build_deposited_file({
        id: 'file-en-retard',
        expected_document_id: 'expected-document-2',
        object_key: 'request-1/expected-document-2/upload-en-retard',
        status: 'pending_scan',
        uploaded_at: add_minutes(REFERENCE_NOW, -60),
      }),
    );
    harness.object_storage.put(
      QUARANTINE_BUCKET_NAME,
      'request-1/expected-document-2/upload-en-retard',
      Buffer.alloc(10),
    );
    harness.object_storage.put(QUARANTINE_BUCKET_NAME, 'orpheline', Buffer.alloc(10));

    const first_pass: ReconciliationReport = await harness.reconcile();
    const second_pass: ReconciliationReport = await harness.reconcile();

    expect(first_pass).toEqual({
      missed_arrivals_recorded: 0,
      abandoned_reservations_discarded: 1,
      overdue_scans_requeued: 1,
      orphan_objects_collected: 1,
    });
    expect(second_pass).toEqual({
      missed_arrivals_recorded: 0,
      abandoned_reservations_discarded: 0,
      // Le scan reste en attente tant que le travailleur n'a pas rendu son
      // verdict : il est bien reenfile a chaque passe, et c'est la cle
      // d'unicite de la file qui empeche le doublon, pas le balayage.
      overdue_scans_requeued: 1,
      orphan_objects_collected: 0,
    });
  });

  it('journalise chaque passe, meme lorsqu il n y a rien a reparer', async () => {
    const harness: ReconciliationHarness = build_reconciliation_harness();

    await harness.reconcile();

    expect(harness.logger.entries_at_level('info')).toContainEqual(
      expect.objectContaining({
        message: 'passe de reconciliation terminee',
        fields: {
          missed_arrivals_recorded: 0,
          abandoned_reservations_discarded: 0,
          overdue_scans_requeued: 0,
          orphan_objects_collected: 0,
        },
      }),
    );
  });
});
