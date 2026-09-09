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
  expected_document: ExpectedDocument,
  file: DepositedFile,
): UploadedFileRejectionReason | null {
  // Le type detecte peut manquer tant que la detection n'a pas tourne : on ne
  // rejette alors sur aucun type, plutot que de traiter l'absence comme un
  // mensonge.
  if (file.detected_mime_type !== null) {
    // Le MENSONGE d'abord, et meme quand le type detecte est par ailleurs
    // interdit : il merite son propre evenement d'audit, la ou un simple type
    // non autorise n'est souvent qu'une erreur de manipulation.
    if (file.detected_mime_type !== file.declared_mime_type) {
      return 'detected_mime_type_mismatch';
    }

    // C'est le type DETECTE qui est confronte a la liste blanche : le
    // Content-Type annonce est declaratif, donc sans valeur.
    if (!expected_document.allowed_mime_types.includes(file.detected_mime_type)) {
      return 'mime_type_not_allowed';
    }
  }

  // Borne INCLUSIVE : un fichier qui pese exactement la limite annoncee la
  // respecte.
  if (file.declared_size_bytes > expected_document.max_size_bytes) {
    return 'declared_size_above_limit';
  }

  // La taille relue sur l'objet prime sur la taille annoncee : le client peut
  // annoncer ce qu'il veut, seul l'objet stocke fait foi.
  if (file.actual_size_bytes !== null && file.actual_size_bytes > expected_document.max_size_bytes) {
    return 'actual_size_above_limit';
  }

  return null;
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
  file: DepositedFile,
  verdict: ScanVerdict,
  now: Date,
): ScanVerdictOutcome {
  // Scanner indisponible n'est PAS un verdict : le fichier reste en attente et
  // `scanned_at` reste vide. Ecrire une date ici ferait passer pour examine un
  // objet que personne n'a ouvert, et la relance periodique ne le reprendrait
  // plus.
  if (verdict === 'scanner_unavailable') {
    return { file_after_verdict: file, must_delete_stored_object: false };
  }

  return {
    file_after_verdict: { ...file, status: verdict, scanned_at: now },
    // Inconditionnel, et c'est le point : ni le statut de depart du fichier, ni
    // l'etat du lien — que cette fonction ne recoit pas — ne sont une raison de
    // laisser un objet infecte dans le bucket.
    must_delete_stored_object: verdict === 'infected',
  };
}

// Ne dit rien d'un fichier deja tranche : seul ce qui attend encore un verdict
// peut etre en retard.
export function is_deposited_file_scan_overdue(
  file: DepositedFile,
  overdue_after_minutes: number,
  now: Date,
): boolean {
  if (file.status !== 'pending_scan' || file.uploaded_at === null) {
    return false;
  }

  const minutes_since_upload: number =
    (now.getTime() - file.uploaded_at.getTime()) / (60 * 1000);

  return minutes_since_upload > overdue_after_minutes;
}

// Une reservation dont le presigned a expire sans qu'aucun objet n'arrive :
// formulaire abandonne, onglet ferme, transfert coupe. Elle n'occupe rien — son
// statut n'est pas occupant — mais elle s'accumule, et surtout elle porte une
// cle d'objet qui restera reservee pour toujours.
export function is_deposited_file_upload_reservation_abandoned(
  file: DepositedFile,
  reservation_grace_minutes: number,
  now: Date,
): boolean {
  if (file.status !== 'pending_upload') {
    return false;
  }

  const minutes_since_reservation: number =
    (now.getTime() - file.created_at.getTime()) / (60 * 1000);

  return minutes_since_reservation > reservation_grace_minutes;
}

// Les statuts pour lesquels la quarantaine ne doit plus rien contenir : le
// fichier a soit ete promu dans le bucket definitif, soit ete efface. Un objet
// qui traine encore la est le reste d'une promotion ou d'une suppression
// interrompue.
const TERMINAL_DEPOSITED_FILE_STATUSES: readonly DepositedFileStatus[] = [
  'clean',
  'infected',
  'rejected',
];

export function should_quarantine_object_be_collected(file: DepositedFile): boolean {
  return TERMINAL_DEPOSITED_FILE_STATUSES.includes(file.status);
}

// Un fichier deja `clean` qui se fait reecrire ne peut pas garder son statut :
// sans cette remise a zero, un fichier sain remplace apres coup heriterait de sa validation.
export function reset_deposited_file_after_new_object_arrival(
  file: DepositedFile,
  now: Date,
): DepositedFile {
  return {
    ...file,
    status: 'pending_scan',
    // Le type detecte repart a zero avec le reste : il decrivait l'objet
    // precedent, et le garder ferait valider le nouveau sur l'examen de
    // l'ancien.
    detected_mime_type: null,
    actual_size_bytes: null,
    uploaded_at: now,
    scanned_at: null,
  };
}

// Rejoue exactement la validation d'arrivee sur l'emplacement TEL QU'IL EST
// DEVENU. Une regle ecrite deux fois finirait par diverger, et la piece deja
// deposee resterait acceptee par une contrainte que l'avocat vient de durcir.
export function should_invalidate_deposited_file_after_expected_document_change(
  expected_document_after_change: ExpectedDocument,
  file: DepositedFile,
): boolean {
  return (
    validate_uploaded_file_against_expected_document(expected_document_after_change, file) !== null
  );
}

export interface DepositedFileRemovalPlan {
  allowed: boolean;
  must_delete_stored_object: boolean;
}

// Le client reprend sa piece tant que la demande n'est pas partie en
// traitement. Apres, elle appartient au dossier de l'avocat : la retirer
// changerait sous ses yeux ce qu'il est en train d'examiner.
export function plan_deposited_file_removal(
  file: DepositedFile,
  deposit_request_status: DepositRequestStatus,
): DepositedFileRemovalPlan {
  return {
    allowed: deposit_request_status === 'incomplete',
    // Rien n'a encore ete ecrit dans le bucket tant que l'upload n'est pas
    // arrive : demander la suppression d'un objet inexistant ferait echouer un
    // retrait parfaitement legitime.
    must_delete_stored_object: file.status !== 'pending_upload',
  };
}

// Seuls les statuts "occupants" comptent : un upload rate ne doit pas condamner
// definitivement l'emplacement en faisant croire au serveur qu'il est servi.
const OCCUPYING_DEPOSITED_FILE_STATUSES: readonly DepositedFileStatus[] = [
  'pending_scan',
  'clean',
];

export function does_deposited_file_occupy_expected_document(file: DepositedFile): boolean {
  return OCCUPYING_DEPOSITED_FILE_STATUSES.includes(file.status);
}
