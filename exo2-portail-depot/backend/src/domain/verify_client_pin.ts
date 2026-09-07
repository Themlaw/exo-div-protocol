import { NotImplementedError } from './not_implemented';
import type { AccessLink } from './access_link';

// Borne appliquee avant tout hachage : le PIN reel ne depasse jamais 12 caracteres,
// et soumettre une chaine enorme a un hachage lent serait un vecteur de deni de service.
export const MAX_SUBMITTED_PIN_LENGTH = 64;

export interface PinHasher {
  hash(pin: string): Promise<string>;
  verify(pin: string, pin_hash: string): Promise<boolean>;
}

export type PinRejectionReason =
  | 'link_invalid'
  | 'link_blocked'
  | 'pin_length_mismatch'
  | 'submitted_pin_too_long'
  | 'pin_incorrect';

export interface PinVerificationOutcome {
  granted: boolean;
  rejection_reason: PinRejectionReason | null;
  link_after_attempt: AccessLink;
  link_just_became_blocked: boolean;
}

export function verify_client_pin(
  _link: AccessLink,
  _submitted_pin: string,
  _now: Date,
  _dependencies: { pin_hasher: PinHasher },
): Promise<PinVerificationOutcome> {
  throw new NotImplementedError('verify_client_pin');
}
