import type { Readable } from 'node:stream';
import type { Clock } from '../shared/clock';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import type { DepositedFile, ScanVerdict, ScanVerdictOutcome } from '../domain/deposited_file';
import {
  apply_scan_verdict_to_deposited_file,
  validate_uploaded_file_against_expected_document,
  type UploadedFileRejectionReason,
} from '../domain/deposited_file';
import type { ExpectedDocument } from '../domain/expected_document';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
} from '../object_storage/object_storage';
import type { DepositedFileRepository } from '../deposited_file/deposited_file_repository';
import type { ExpectedDocumentRepository } from '../deposit/expected_document_repository';
import {
  DETECTION_PREFIX_BYTES,
  detect_mime_type_from_prefix,
} from '../deposited_file/file_signatures';
import type { FileScanner } from './clamav_scanner';

export const DEPOSITED_FILE_SCANNER: unique symbol = Symbol('DEPOSITED_FILE_SCANNER');
export const SCAN_LOG_CONTEXT = 'scan';

export type ScanOutcome =
  | { kind: 'clean' }
  | { kind: 'rejected'; reason: UploadedFileRejectionReason }
  | { kind: 'infected' }
  | { kind: 'scanner_unavailable' }
  | { kind: 'nothing_to_scan' };

export interface DepositedFileScanner {
  scan(deposited_file_id: string): Promise<ScanOutcome>;
}

export interface DepositedFileScanDependencies {
  deposited_files: DepositedFileRepository;
  expected_documents: ExpectedDocumentRepository;
  object_storage: ObjectStorage;
  file_scanner: FileScanner;
  clock: Clock;
  logger: ApplicationLogger;
}

export class DepositedFileScanService implements DepositedFileScanner {
  constructor(private readonly dependencies: DepositedFileScanDependencies) {}

  async scan(deposited_file_id: string): Promise<ScanOutcome> {
    const file: DepositedFile | null =
      await this.dependencies.deposited_files.find_by_id(deposited_file_id);

    // La piece a pu etre retiree entre l'enfilement et l'execution. Ce n'est pas
    // une panne : le job a simplement perdu son objet.
    if (file === null || file.status !== 'pending_scan') {
      return { kind: 'nothing_to_scan' };
    }

    // Le VIRUS d'abord, la conformite ensuite. Un fichier infecte doit quitter
    // le bucket meme s'il etait par ailleurs d'un type interdit : le rejeter
    // pour son type laisserait l'objet en place.
    const verdict: ScanVerdict = await this.scan_stored_object(file);

    if (verdict === 'scanner_unavailable') {
      // Le domaine laisse la piece en attente et ne date rien : la reprise la
      // reprendra, et graphile-worker rejouera ce job avec son propre recul.
      return { kind: 'scanner_unavailable' };
    }

    if (verdict === 'infected') {
      await this.apply_verdict(file, 'infected');
      this.dependencies.logger.warn(SCAN_LOG_CONTEXT, 'piece infectee, objet supprime', {
        deposited_file_id: file.id,
      });
      return { kind: 'infected' };
    }

    return this.apply_conformity_of(file);
  }

  private async scan_stored_object(file: DepositedFile): Promise<ScanVerdict> {
    const content: Readable = await this.dependencies.object_storage.open_object_stream(
      QUARANTINE_BUCKET_NAME,
      file.object_key,
    );

    return this.dependencies.file_scanner.scan_stream(content);
  }

  // Le type DETECTE est ecrit avant toute decision : c'est lui qui fait foi, et
  // le conserver rend le rejet explicable apres coup.
  private async apply_conformity_of(file: DepositedFile): Promise<ScanOutcome> {
    const prefix: Buffer = await this.dependencies.object_storage.read_object_prefix(
      QUARANTINE_BUCKET_NAME,
      file.object_key,
      DETECTION_PREFIX_BYTES,
    );

    const scanned_file: DepositedFile = {
      ...file,
      detected_mime_type: detect_mime_type_from_prefix(prefix),
    };

    const expected_document: ExpectedDocument | null =
      await this.dependencies.expected_documents.find_by_id(file.expected_document_id);

    // Un format que la liste des signatures ne nomme pas est un rejet : on ne
    // laisse pas passer ce qu'on n'a pas su reconnaitre.
    const rejection_reason: UploadedFileRejectionReason | null =
      expected_document === null || scanned_file.detected_mime_type === null
        ? 'mime_type_not_allowed'
        : validate_uploaded_file_against_expected_document(expected_document, scanned_file);

    if (rejection_reason !== null) {
      await this.dependencies.deposited_files.save_state({
        ...scanned_file,
        status: 'rejected',
        scanned_at: this.dependencies.clock.now(),
      });
      // Un fichier rejete n'a plus de raison d'occuper le bucket : il ne sera
      // jamais servi, et le garder ferait grossir la quarantaine sans fin.
      await this.dependencies.object_storage.delete_object(
        QUARANTINE_BUCKET_NAME,
        file.object_key,
      );
      return { kind: 'rejected', reason: rejection_reason };
    }

    await this.apply_verdict(scanned_file, 'clean');
    return { kind: 'clean' };
  }

  // L'objet bouge AVANT que la ligne ne l'annonce sain. Dans l'autre sens, une
  // panne entre les deux laisserait une piece declaree propre dont l'objet est
  // encore en quarantaine, donc introuvable la ou on ira la chercher.
  private async apply_verdict(file: DepositedFile, verdict: ScanVerdict): Promise<void> {
    const outcome: ScanVerdictOutcome = apply_scan_verdict_to_deposited_file(
      file,
      verdict,
      this.dependencies.clock.now(),
    );

    if (outcome.must_delete_stored_object) {
      await this.dependencies.object_storage.delete_object(
        QUARANTINE_BUCKET_NAME,
        file.object_key,
      );
    } else if (outcome.file_after_verdict.status === 'clean') {
      await this.dependencies.object_storage.promote_object({
        from_bucket: QUARANTINE_BUCKET_NAME,
        to_bucket: VERIFIED_BUCKET_NAME,
        object_key: file.object_key,
      });
    }

    await this.dependencies.deposited_files.save_state(outcome.file_after_verdict);
  }
}
