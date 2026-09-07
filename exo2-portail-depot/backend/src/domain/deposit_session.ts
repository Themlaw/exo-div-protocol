import { NotImplementedError } from './not_implemented';
import type { AccessLink } from './access_link';

export interface DepositSession {
  id: string;
  access_link_id: string;
  created_at: Date;
  expires_at: Date;
}

export type DepositSessionRejectionReason =
  | 'session_expired'
  | 'session_belongs_to_another_link'
  | 'access_link_no_longer_usable';

export interface DepositSessionUsability {
  usable: boolean;
  rejection_reason: DepositSessionRejectionReason | null;
}

// L'echeance est BORNEE par celle du lien, jamais additionnee : sinon un client
// qui deverrouille juste avant l'echeance repartirait avec une session valide apres.
export function open_client_deposit_session(
  _link: AccessLink,
  _requested_lifetime_seconds: number,
  _now: Date,
): DepositSession {
  throw new NotImplementedError('open_client_deposit_session');
}

export function is_deposit_session_usable(
  _session: DepositSession,
  _link: AccessLink,
  _now: Date,
): DepositSessionUsability {
  throw new NotImplementedError('is_deposit_session_usable');
}
