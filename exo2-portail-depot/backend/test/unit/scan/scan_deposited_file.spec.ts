import type { Readable } from 'node:stream';
import type { DepositedFile, ScanVerdict } from '../../../src/domain/deposited_file';
import type { NewActivityEvent } from '../../../src/domain/activity_event';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
} from '../../../src/object_storage/object_storage';
import type { FileScanner, ScannerAvailability } from '../../../src/scan/clamav_scanner';
import {
  DepositedFileScanService,
  SCAN_LOG_CONTEXT,
  type ScanOutcome,
} from '../../../src/scan/scan_deposited_file';
import type { Clock } from '../../../src/shared/clock';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';
import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { FakeDepositedFileRepository } from '../../helpers/fake_deposited_file_repository';
import { FakeExpectedDocumentRepository } from '../../helpers/fake_expected_document_repository';
import { FakeDepositRequestLifecycle } from '../../helpers/fake_deposit_request_lifecycle';
import { FakeObjectStorage } from '../../helpers/fake_object_storage';
import {
  REFERENCE_NOW,
  build_deposited_file,
  build_expected_document,
} from '../../fixtures/domain_builders';

const PDF_CONTENT: Buffer = Buffer.from('%PDF-1.7\nun contrat signe', 'ascii');
const PNG_CONTENT: Buffer = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('une photo', 'ascii'),
]);
const UNRECOGNIZED_CONTENT: Buffer = Buffer.from('des octets qu aucune signature ne nomme', 'ascii');

class FixedVerdictFileScanner implements FileScanner {
  scan_call_count = 0;

  constructor(private readonly verdict: ScanVerdict) {}

  async scan_stream(content: Readable): Promise<ScanVerdict> {
    this.scan_call_count += 1;
    content.destroy();
    return this.verdict;
  }

  // Un scanner qui rend un verdict est joignable : la sonde n'a pas d'autre
  // sens ici, et ces tests ne parlent que de verdicts.
  async probe_availability(): Promise<ScannerAvailability> {
    return this.verdict === 'scanner_unavailable' ? 'unavailable' : 'available';
  }
}

class WriteCountingDepositedFileRepository extends FakeDepositedFileRepository {
  save_state_call_count = 0;

  override async save_state(file: DepositedFile): Promise<void> {
    this.save_state_call_count += 1;
    await super.save_state(file);
  }
}

interface ScanTestContext {
  service: DepositedFileScanService;
  deposited_files: WriteCountingDepositedFileRepository;
  expected_documents: FakeExpectedDocumentRepository;
  activity_events: FakeActivityEventRepository;
  deposit_request_lifecycle: FakeDepositRequestLifecycle;
  object_storage: FakeObjectStorage;
  file_scanner: FixedVerdictFileScanner;
  logger: CapturingLogger;
}

function build_scan_test_context(
  verdict: ScanVerdict,
  deposited_files: WriteCountingDepositedFileRepository = new WriteCountingDepositedFileRepository(),
): ScanTestContext {
  const expected_documents = new FakeExpectedDocumentRepository();
  const activity_events = new FakeActivityEventRepository();
  const deposit_request_lifecycle = new FakeDepositRequestLifecycle();
  const object_storage = new FakeObjectStorage();
  const file_scanner = new FixedVerdictFileScanner(verdict);
  const logger: CapturingLogger = build_capturing_logger();
  const clock: Clock = { now: (): Date => REFERENCE_NOW };

  return {
    service: new DepositedFileScanService({
      deposited_files,
      expected_documents,
      activity_events,
      deposit_request_lifecycle,
      object_storage,
      file_scanner,
      clock,
      logger,
    }),
    deposited_files,
    expected_documents,
    activity_events,
    deposit_request_lifecycle,
    object_storage,
    file_scanner,
    logger,
  };
}

function seed_quarantined_file(
  context: ScanTestContext,
  file: DepositedFile,
  content: Buffer,
): void {
  context.deposited_files.seed(file);
  context.object_storage.put(QUARANTINE_BUCKET_NAME, file.object_key, content);
}

describe('DepositedFileScanService', () => {
  it('ne scanne rien et n\'ecrit rien quand la piece a disparu entre l\'enfilement et l\'execution', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');

    const outcome: ScanOutcome = await context.service.scan('file-inconnue');

    expect(outcome).toEqual({ kind: 'nothing_to_scan' });
    expect(context.file_scanner.scan_call_count).toBe(0);
    expect(context.deposited_files.save_state_call_count).toBe(0);
  });

  it.each(['pending_upload', 'clean', 'infected', 'rejected'] as const)(
    'ne scanne rien et n\'ecrit rien quand la piece n\'est plus en pending_scan (%s)',
    async (status) => {
      const context: ScanTestContext = build_scan_test_context('clean');
      const file: DepositedFile = build_deposited_file({ status });
      seed_quarantined_file(context, file, PDF_CONTENT);

      const outcome: ScanOutcome = await context.service.scan(file.id);

      expect(outcome).toEqual({ kind: 'nothing_to_scan' });
      expect(context.file_scanner.scan_call_count).toBe(0);
      expect(context.deposited_files.save_state_call_count).toBe(0);
    },
  );

  it('sur un verdict infecte, passe la piece a infected, supprime l\'objet et ne promeut rien', async () => {
    const context: ScanTestContext = build_scan_test_context('infected');
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    context.expected_documents.seed(build_expected_document());

    const outcome: ScanOutcome = await context.service.scan(file.id);

    expect(outcome).toEqual({ kind: 'infected' });
    expect(context.deposited_files.files.get(file.id)?.status).toBe('infected');
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
    expect(context.object_storage.keys_of(VERIFIED_BUCKET_NAME)).toEqual([]);
    expect(context.logger.entries_at_level('warn')).toHaveLength(1);
  });

  // Dater un scan que personne n'a mene ferait passer la piece pour examinee et
  // la sortirait du champ de la reprise periodique.
  it('sur un scanner indisponible, n\'ecrit rien : la piece reste en pending_scan et sa date de scan reste vide', async () => {
    const context: ScanTestContext = build_scan_test_context('scanner_unavailable');
    const file: DepositedFile = build_deposited_file({ scanned_at: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    context.expected_documents.seed(build_expected_document());

    const outcome: ScanOutcome = await context.service.scan(file.id);

    expect(outcome).toEqual({ kind: 'scanner_unavailable' });
    expect(context.deposited_files.save_state_call_count).toBe(0);
    expect(context.deposited_files.files.get(file.id)?.status).toBe('pending_scan');
    expect(context.deposited_files.files.get(file.id)?.scanned_at).toBeNull();
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([file.object_key]);
  });

  it('rejette un contenu qu\'aucune signature ne nomme et retire son objet de la quarantaine', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null });
    seed_quarantined_file(context, file, UNRECOGNIZED_CONTENT);
    context.expected_documents.seed(build_expected_document());

    const outcome: ScanOutcome = await context.service.scan(file.id);

    expect(outcome).toEqual({ kind: 'rejected', reason: 'mime_type_not_allowed' });
    expect(context.deposited_files.files.get(file.id)?.status).toBe('rejected');
    expect(context.deposited_files.files.get(file.id)?.detected_mime_type).toBeNull();
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
    expect(context.object_storage.keys_of(VERIFIED_BUCKET_NAME)).toEqual([]);
  });

  it('rejette pour mensonge sur le type quand le contenu detecte ne correspond pas au type annonce', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: null,
    });
    seed_quarantined_file(context, file, PNG_CONTENT);
    context.expected_documents.seed(build_expected_document());

    const outcome: ScanOutcome = await context.service.scan(file.id);

    expect(outcome).toEqual({ kind: 'rejected', reason: 'detected_mime_type_mismatch' });
    expect(context.deposited_files.files.get(file.id)?.detected_mime_type).toBe('image/png');
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
  });

  // Le journal dit a l'avocat QU'UNE piece a ete refusee ; l'exploitant, lui, a
  // besoin de savoir POURQUOI. Sans les deux types, un client qui s'est trompe
  // de fichier et un envoi maquille se ressemblent dans les journaux.
  it("journalise le rejet avec le type annonce et le type detecte, jamais le nom depose", async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: null,
      display_filename: 'facture_maquillee.pdf',
    });
    seed_quarantined_file(context, file, PNG_CONTENT);
    context.expected_documents.seed(build_expected_document());

    await context.service.scan(file.id);

    expect(context.logger.entries_at_level('warn')).toEqual([
      {
        level: 'warn',
        context: SCAN_LOG_CONTEXT,
        message: 'piece refusee, objet supprime',
        fields: {
          deposited_file_id: file.id,
          expected_document_id: file.expected_document_id,
          rejection_reason: 'detected_mime_type_mismatch',
          declared_mime_type: 'application/pdf',
          detected_mime_type: 'image/png',
        },
      },
    ]);
    // Le nom vient d'un tiers non authentifie, et les journaux sont lus par
    // plus de monde que la base.
    expect(JSON.stringify(context.logger.captured_entries)).not.toContain('facture_maquillee');
  });

  it('rejette la piece dont l\'emplacement attendu a disparu : plus aucune liste blanche ne l\'autorise', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null });
    seed_quarantined_file(context, file, PDF_CONTENT);

    const outcome: ScanOutcome = await context.service.scan(file.id);

    expect(outcome).toEqual({ kind: 'rejected', reason: 'mime_type_not_allowed' });
    expect(context.deposited_files.files.get(file.id)?.status).toBe('rejected');
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
  });

  it('sur une piece saine et conforme, promeut l\'objet dans le bucket verifie et l\'inscrit clean, type detecte et date de scan renseignes', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null, scanned_at: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    context.expected_documents.seed(build_expected_document());

    const outcome: ScanOutcome = await context.service.scan(file.id);

    expect(outcome).toEqual({ kind: 'clean' });
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
    expect(context.object_storage.keys_of(VERIFIED_BUCKET_NAME)).toEqual([file.object_key]);
    const file_after_scan: DepositedFile | undefined = context.deposited_files.files.get(file.id);
    expect(file_after_scan?.status).toBe('clean');
    expect(file_after_scan?.detected_mime_type).toBe('application/pdf');
    expect(file_after_scan?.scanned_at).toEqual(REFERENCE_NOW);
  });

  // Dans l'autre ordre, une panne entre les deux laisserait une piece declaree
  // saine dont l'objet dort encore en quarantaine, donc introuvable la ou on ira
  // la chercher.
  it('promeut l\'objet AVANT d\'inscrire la piece clean : une ecriture qui echoue laisse l\'objet deja dans le bucket verifie', async () => {
    class RefusingCleanWriteRepository extends WriteCountingDepositedFileRepository {
      override async save_state(file: DepositedFile): Promise<void> {
        await super.save_state(file);
        throw new Error('ecriture impossible');
      }
    }

    const context: ScanTestContext = build_scan_test_context(
      'clean',
      new RefusingCleanWriteRepository(),
    );
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null, scanned_at: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    context.expected_documents.seed(build_expected_document());

    await expect(context.service.scan(file.id)).rejects.toThrow('ecriture impossible');

    expect(context.object_storage.keys_of(VERIFIED_BUCKET_NAME)).toEqual([file.object_key]);
    expect(context.object_storage.keys_of(QUARANTINE_BUCKET_NAME)).toEqual([]);
  });

  it('journalise un verdict infecte au nom du systeme, rattache a la demande du document attendu', async () => {
    const context: ScanTestContext = build_scan_test_context('infected');
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    context.expected_documents.seed(build_expected_document());

    await context.service.scan(file.id);

    expect(context.activity_events.recorded_events).toEqual<NewActivityEvent[]>([
      {
        deposit_request_id: build_expected_document().deposit_request_id,
        type: 'deposited_file_scanned_infected',
        actor: { kind: 'system' },
        access_link_id: file.access_link_id,
        deposited_file_id: file.id,
        client_ip: null,
        occurred_at: REFERENCE_NOW,
      },
    ]);
  });

  it('journalise un rejet de conformite au nom du systeme', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: null,
    });
    seed_quarantined_file(context, file, PNG_CONTENT);
    context.expected_documents.seed(build_expected_document());

    await context.service.scan(file.id);

    expect(context.activity_events.recorded_types()).toEqual(['deposited_file_rejected']);
    expect(context.activity_events.recorded_events[0]?.actor).toEqual({ kind: 'system' });
  });

  it('journalise une piece saine et conforme au nom du systeme', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null, scanned_at: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    context.expected_documents.seed(build_expected_document());

    await context.service.scan(file.id);

    expect(context.activity_events.recorded_types()).toEqual(['deposited_file_scanned_clean']);
    expect(context.activity_events.recorded_events[0]?.actor).toEqual({ kind: 'system' });
  });

  // Rien n'a ete tranche : inscrire un verdict que le scanner n'a jamais rendu
  // ferait mentir l'audit sur une piece encore en attente d'examen.
  it('ne journalise aucun verdict quand le scanner est indisponible', async () => {
    const context: ScanTestContext = build_scan_test_context('scanner_unavailable');
    const file: DepositedFile = build_deposited_file({ scanned_at: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    context.expected_documents.seed(build_expected_document());

    await context.service.scan(file.id);

    expect(context.activity_events.recorded_types()).toEqual([]);
  });

  it.each(['piece-introuvable', 'piece-deja-tranchee'] as const)(
    'ne journalise rien quand il n\'y a plus rien a scanner (%s)',
    async (situation) => {
      const context: ScanTestContext = build_scan_test_context('clean');
      context.expected_documents.seed(build_expected_document());
      const file: DepositedFile = build_deposited_file({ status: 'clean' });

      if (situation === 'piece-deja-tranchee') {
        seed_quarantined_file(context, file, PDF_CONTENT);
      }

      const outcome: ScanOutcome = await context.service.scan(file.id);

      expect(outcome).toEqual({ kind: 'nothing_to_scan' });
      expect(context.activity_events.recorded_types()).toEqual([]);
    },
  );

  // Le scan annonce un FAIT — cette piece est saine — et rien de plus : c'est le
  // cycle de vie qui sait ce que « le dossier est complet » veut dire.
  it('signale au cycle de vie la piece devenue saine, avec la demande qu elle sert', async () => {
    const context: ScanTestContext = build_scan_test_context('clean');
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null });
    seed_quarantined_file(context, file, PDF_CONTENT);
    const expected_document = build_expected_document({ deposit_request_id: 'request-42' });
    context.expected_documents.seed(expected_document);

    await context.service.scan(file.id);

    expect(context.deposit_request_lifecycle.clean_notices).toEqual(['request-42']);
    expect(context.deposit_request_lifecycle.applied_events).toEqual([]);
  });

  // La completude est REVOCABLE : un verdict qui se degrade doit rouvrir la
  // demande, sinon une piece infectee ou refusee resterait acquise.
  it.each([
    ['infecte', 'infected' as const, PDF_CONTENT],
    ['refuse', 'clean' as const, UNRECOGNIZED_CONTENT],
  ])('signale la perte de completude sur un verdict %s', async (_label, verdict, content) => {
    const context: ScanTestContext = build_scan_test_context(verdict);
    const file: DepositedFile = build_deposited_file({ detected_mime_type: null });
    seed_quarantined_file(context, file, content);
    context.expected_documents.seed(build_expected_document({ deposit_request_id: 'request-42' }));

    await context.service.scan(file.id);

    expect(context.deposit_request_lifecycle.recorded_pipeline_events).toEqual([
      { deposit_request_id: 'request-42', event: 'expected_document_became_not_clean' },
    ]);
    expect(context.deposit_request_lifecycle.clean_notices).toEqual([]);
  });

  // L'emplacement disparu veut dire la demande disparue — la cascade est la
  // seule facon d'effacer un document attendu. Le cycle de vie n'aurait plus
  // rien a faire evoluer.
  it.each(['clean', 'infected'] as const)(
    'ne signale rien quand l emplacement de la piece a disparu (%s)',
    async (verdict) => {
      const context: ScanTestContext = build_scan_test_context(verdict);
      const file: DepositedFile = build_deposited_file({ detected_mime_type: null });
      seed_quarantined_file(context, file, PDF_CONTENT);

      await context.service.scan(file.id);

      expect(context.deposit_request_lifecycle.recorded_pipeline_events).toEqual([]);
      expect(context.deposit_request_lifecycle.clean_notices).toEqual([]);
    },
  );
});
