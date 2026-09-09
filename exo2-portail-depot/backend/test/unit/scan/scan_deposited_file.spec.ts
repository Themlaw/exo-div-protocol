import type { Readable } from 'node:stream';
import type { DepositedFile, ScanVerdict } from '../../../src/domain/deposited_file';
import type { ExpectedDocument } from '../../../src/domain/expected_document';
import type { ExpectedDocumentRepository } from '../../../src/deposit/expected_document_repository';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
} from '../../../src/object_storage/object_storage';
import type { FileScanner } from '../../../src/scan/clamav_scanner';
import {
  DepositedFileScanService,
  type ScanOutcome,
} from '../../../src/scan/scan_deposited_file';
import type { Clock } from '../../../src/shared/clock';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';
import { FakeDepositedFileRepository } from '../../helpers/fake_deposited_file_repository';
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

class FakeExpectedDocumentRepository implements ExpectedDocumentRepository {
  private readonly documents = new Map<string, ExpectedDocument>();

  seed(...documents: readonly ExpectedDocument[]): void {
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
  }

  async find_by_id(expected_document_id: string): Promise<ExpectedDocument | null> {
    return this.documents.get(expected_document_id) ?? null;
  }
}

class FixedVerdictFileScanner implements FileScanner {
  scan_call_count = 0;

  constructor(private readonly verdict: ScanVerdict) {}

  async scan_stream(content: Readable): Promise<ScanVerdict> {
    this.scan_call_count += 1;
    content.destroy();
    return this.verdict;
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
  object_storage: FakeObjectStorage;
  file_scanner: FixedVerdictFileScanner;
  logger: CapturingLogger;
}

function build_scan_test_context(
  verdict: ScanVerdict,
  deposited_files: WriteCountingDepositedFileRepository = new WriteCountingDepositedFileRepository(),
): ScanTestContext {
  const expected_documents = new FakeExpectedDocumentRepository();
  const object_storage = new FakeObjectStorage();
  const file_scanner = new FixedVerdictFileScanner(verdict);
  const logger: CapturingLogger = build_capturing_logger();
  const clock: Clock = { now: (): Date => REFERENCE_NOW };

  return {
    service: new DepositedFileScanService({
      deposited_files,
      expected_documents,
      object_storage,
      file_scanner,
      clock,
      logger,
    }),
    deposited_files,
    expected_documents,
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
});
