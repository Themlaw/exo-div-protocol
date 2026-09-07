import { NotImplementedError } from './not_implemented';

export type AccessLinkStatus = 'active' | 'blocked' | 'revoked';

export interface AccessLink {
  id: string;
  deposit_request_id: string;
  token_hmac: string;
  token_pepper_version: number;
  pin_hash: string;
  pin_length: number;
  max_pin_attempts: number;
  failed_pin_attempts: number;
  status: AccessLinkStatus;
  expires_at: Date;
  created_at: Date;
  blocked_at: Date | null;
  revoked_at: Date | null;
}

// Ce que le client anonyme a le droit de savoir AVANT d'avoir passe le PIN.
// "inexistant" et "expire" partagent volontairement `invalid` : les distinguer
// dirait a un attaquant que le token a existe.
export type PublicAccessLinkState = 'active' | 'invalid' | 'blocked';

export function resolve_public_access_link_state(
  _link: AccessLink | null,
  _now: Date,
): PublicAccessLinkState {
  throw new NotImplementedError('resolve_public_access_link_state');
}

export function is_access_link_usable(_link: AccessLink, _now: Date): boolean {
  throw new NotImplementedError('is_access_link_usable');
}
