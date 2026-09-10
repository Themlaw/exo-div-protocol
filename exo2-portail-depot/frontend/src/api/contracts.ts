// Les formes que l'API rend, vues du navigateur.
//
// Elles sont ecrites A LA MAIN plutot qu'importees du backend : le front ne doit
// embarquer aucune ligne de Nest, et surtout les deux ne sont pas identiques —
// une `Date` traverse JSON en CHAINE ISO. Un type partage tel quel promettrait
// des objets `Date` que `fetch` ne rend jamais.
//
// La derive est tenue par `test/api/contracts_drift.spec.ts` : il compare
// chaque contrat au type du backend serialise, et il echoue au typecheck.

export type DepositRequestStatus =
  | 'incomplete'
  | 'processing'
  | 'validated'
  | 'blocked'
  | 'expired_incomplete';

// Enumere a l'execution, et pas seulement au typage : le client d'API doit
// pouvoir verifier le statut que le backend joint a un refus de telechargement
// avant de le peindre a l'ecran.
export const DEPOSITED_FILE_STATUSES = [
  'pending_upload',
  'pending_scan',
  'clean',
  'infected',
  'rejected',
] as const;

export type DepositedFileStatus = (typeof DEPOSITED_FILE_STATUSES)[number];

export type PublicAccessLinkState = 'active' | 'blocked' | 'invalid';

export interface SecurityPolicy {
  max_pin_attempts: number;
  link_lifetime_days: number;
  pin_length: number;
}

// Les seules valeurs de ce fichier qui ne DECRIVENT pas une reponse : elles
// arment le formulaire de creation. Elles sont recopiees du domaine backend
// plutot qu'importees — le front n'embarque aucune ligne de Nest — et
// `test/api/security_policy_drift.spec.ts` echoue si la copie derive.
//
// Elles ne remplacent pas la validation serveur, elles l'annoncent : un
// parametre de securite regle par le client est un parametre absent.
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  max_pin_attempts: 10,
  link_lifetime_days: 7,
  pin_length: 6,
};

export const SECURITY_POLICY_BOUNDS = {
  max_pin_attempts: { min: 5, max: 20 },
  link_lifetime_days: { min: 1, max: 14 },
  pin_length: { min: 4, max: 12 },
} as const;

export interface DepositRequestActivitySummary {
  has_problem: boolean;
  infected_count: number;
  rejected_count: number;
  rejected_pin_attempt_count: number;
  unusable_link_attempt_count: number;
  was_link_blocked: boolean;
}

export interface DepositRequestOverview {
  id: string;
  title: string;
  status: DepositRequestStatus;
  expected_document_count: number;
  deposited_document_count: number;
  link_expires_at: string | null;
  created_at: string;
  activity_summary: DepositRequestActivitySummary;
}

export interface LawyerDepositedFileView {
  id: string;
  display_filename: string;
  declared_mime_type: string;
  size_bytes: number | null;
  status: DepositedFileStatus;
  uploaded_at: string | null;
  scanned_at: string | null;
}

export interface LawyerExpectedDocumentView {
  id: string;
  label: string;
  position: number;
  allowed_mime_types: string[];
  max_size_bytes: number;
  deposited_file: LawyerDepositedFileView | null;
}

export interface DepositRequestDetail {
  id: string;
  title: string;
  status: DepositRequestStatus;
  security_policy: SecurityPolicy;
  created_at: string;
  link_expires_at: string | null;
  expected_documents: LawyerExpectedDocumentView[];
}

// Rendu UNE SEULE FOIS, a la creation ou a la regeneration : le PIN n'est jamais
// relisible ensuite. C'est la raison pour laquelle l'ecran doit le presenter
// comme un message pret a envoyer, et non comme une donnee qu'on pourra
// retrouver.
export interface AccessLinkDelivery {
  url: string;
  pin: string;
  message: string;
  expires_at: string;
}

// Enumere a l'execution : c'est ce qui permet a un test de balayer LES QUINZE
// types et de prouver qu'aucun n'atteint l'ecran sans traduction francaise.
export const ACTIVITY_EVENT_TYPES = [
  'access_link_issued',
  'access_link_revoked',
  'access_link_blocked',
  'unusable_access_link_attempted',
  'deposit_session_opened',
  'client_pin_rejected',
  'deposited_file_received',
  'deposited_file_removed',
  'deposited_file_scanned_clean',
  'deposited_file_scanned_infected',
  'deposited_file_rejected',
  'deposited_file_downloaded',
  'deposit_request_completed_by_client',
  'deposit_request_validated',
  'deposit_request_expired',
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

export type ActivityActor =
  | { kind: 'lawyer'; user_id: string }
  | { kind: 'client' }
  | { kind: 'system' };

// L'adresse du client N'Y FIGURE PAS, et ce n'est pas un oubli : rendue a un
// navigateur, elle finirait dans une capture d'ecran ou un PDF imprime, deux
// endroits que la purge a trente jours n'atteindra jamais.
export interface LawyerActivityEventView {
  id: string;
  type: ActivityEventType;
  actor: ActivityActor;
  access_link_id: string | null;
  deposited_file_id: string | null;
  occurred_at: string;
}

export interface LawyerActivityPage {
  events: LawyerActivityEventView[];
  has_more: boolean;
}

export interface PresignedDownloadTicket {
  download_url: string;
  expires_at: string;
}

// --- Surface client anonyme ---

export interface PublicAccessLinkView {
  state: PublicAccessLinkState;
  pin_length?: number;
}

export interface ClientDepositedFileView {
  id: string;
  display_filename: string;
  status: DepositedFileStatus;
}

export interface ClientExpectedDocumentView {
  id: string;
  label: string;
  position: number;
  allowed_mime_types: readonly string[];
  max_size_bytes: number;
  deposited_file: ClientDepositedFileView | null;
}

export interface ClientDepositBoardView {
  title: string;
  deposit_request_status: DepositRequestStatus;
  session_expires_at: string;
  expected_documents: readonly ClientExpectedDocumentView[];
}

export interface ClientUploadTicketView {
  deposited_file_id: string;
  upload_url: string;
  form_fields: Readonly<Record<string, string>>;
  expires_at: string;
}
