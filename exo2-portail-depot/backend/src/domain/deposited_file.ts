import { NotImplementedError } from './not_implemented';
import type { DepositRequestStatus } from './deposit_request_status';
import type { ExpectedDocument } from './expected_document';

export type DepositedFileStatus =
  | 'pending_upload'
  | 'pending_scan'
  | 'clean'
  | 'infected'
  | 'rejected';

export interface DepositedFile {
  id: string;
  expected_document_id: string;
  access_link_id: string;
  object_key: string;
  display_filename: string;
  declared_mime_type: string;
  detected_mime_type: string | null;
  declared_size_bytes: number;
  actual_size_bytes: number | null;
  status: DepositedFileStatus;
  created_at: Date;
  uploaded_at: Date | null;
  scanned_at: Date | null;
}

export type UploadedFileRejectionReason =
  | 'mime_type_not_allowed'
  | 'declared_size_above_limit'
  | 'actual_size_above_limit'
  | 'detected_mime_type_mismatch';

// Le Content-Type annonce par le client est declaratif : seul le type reellement
// detecte fait foi, et la taille reelle relue sur l'objet prime sur la taille annoncee.
export function validate_uploaded_file_against_expected_document(
  _expected_document: ExpectedDocument,
  _file: DepositedFile,
): UploadedFileRejectionReason | null {
  throw new NotImplementedError('validate_uploaded_file_against_expected_document');
}

export type ScanVerdict = 'clean' | 'infected' | 'scanner_unavailable';

export interface ScanVerdictOutcome {
  file_after_verdict: DepositedFile;
  must_delete_stored_object: boolean;
}

// La suppression d'un objet infecte n'est jamais conditionnee par l'etat du lien
// ni de la demande : un lien expire n'est pas une raison de laisser un virus
// dans le bucket de quarantaine.
export function apply_scan_verdict_to_deposited_file(
  _file: DepositedFile,
  _verdict: ScanVerdict,
  _now: Date,
): ScanVerdictOutcome {
  throw new NotImplementedError('apply_scan_verdict_to_deposited_file');
}

export function is_deposited_file_scan_overdue(
  _file: DepositedFile,
  _overdue_after_minutes: number,
  _now: Date,
): boolean {
  throw new NotImplementedError('is_deposited_file_scan_overdue');
}

// Un fichier deja `clean` qui se fait reecrire ne peut pas garder son statut :
// sans cette remise a zero, un fichier sain remplace apres coup heriterait de sa validation.
export function reset_deposited_file_after_new_object_arrival(
  _file: DepositedFile,
  _now: Date,
): DepositedFile {
  throw new NotImplementedError('reset_deposited_file_after_new_object_arrival');
}

export function should_invalidate_deposited_file_after_expected_document_change(
  _expected_document_after_change: ExpectedDocument,
  _file: DepositedFile,
): boolean {
  throw new NotImplementedError(
    'should_invalidate_deposited_file_after_expected_document_change',
  );
}

export interface DepositedFileRemovalPlan {
  allowed: boolean;
  must_delete_stored_object: boolean;
}

export function plan_deposited_file_removal(
  _file: DepositedFile,
  _deposit_request_status: DepositRequestStatus,
): DepositedFileRemovalPlan {
  throw new NotImplementedError('plan_deposited_file_removal');
}

// Seuls les statuts "occupants" comptent : un upload rate ne doit pas condamner
// definitivement l'emplacement en faisant croire au serveur qu'il est servi.
export function does_deposited_file_occupy_expected_document(
  _file: DepositedFile,
): boolean {
  throw new NotImplementedError('does_deposited_file_occupy_expected_document');
}
