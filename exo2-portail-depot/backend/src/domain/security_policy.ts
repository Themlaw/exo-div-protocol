export interface SecurityPolicy {
  max_pin_attempts: number;
  link_lifetime_days: number;
  pin_length: number;
}

export const SECURITY_POLICY_BOUNDS = {
  max_pin_attempts: { min: 5, max: 20 },
  link_lifetime_days: { min: 1, max: 14 },
  pin_length: { min: 4, max: 12 },
} as const;

// Revises le 2026-09-09. Le client se trompe bien plus souvent qu'un attaquant
// ne reussit : a 5 essais, un destinataire un peu maladroit se faisait bloquer
// et le cout retombait sur l'avocat, qui devait regenerer. Les deux valeurs ont
// ete relevees ENSEMBLE — dix essais sur un million de combinaisons garde le
// meme rapport que cinq sur dix mille.
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  max_pin_attempts: 10,
  link_lifetime_days: 7,
  pin_length: 6,
};

export type SecurityPolicyViolation =
  | 'max_pin_attempts_out_of_bounds'
  | 'link_lifetime_days_out_of_bounds'
  | 'pin_length_out_of_bounds';

// Validee COTE SERVEUR, toujours : un parametre de securite regle par le client
// est un parametre de securite absent. Le formulaire peut refaire le meme
// controle, il ne peut pas le remplacer.
//
// Rend toutes les violations plutot que la premiere, comme la validation de
// creation : trois champs mal regles se corrigent en une passe.
export function validate_security_policy(
  submitted_policy: SecurityPolicy,
): SecurityPolicyViolation[] {
  const violations: SecurityPolicyViolation[] = [];

  if (
    !is_within_inclusive_bounds(
      submitted_policy.max_pin_attempts,
      SECURITY_POLICY_BOUNDS.max_pin_attempts,
    )
  ) {
    violations.push('max_pin_attempts_out_of_bounds');
  }

  if (
    !is_within_inclusive_bounds(
      submitted_policy.link_lifetime_days,
      SECURITY_POLICY_BOUNDS.link_lifetime_days,
    )
  ) {
    violations.push('link_lifetime_days_out_of_bounds');
  }

  if (
    !is_within_inclusive_bounds(submitted_policy.pin_length, SECURITY_POLICY_BOUNDS.pin_length)
  ) {
    violations.push('pin_length_out_of_bounds');
  }

  return violations;
}

// `Number.isSafeInteger` d'abord, et pas seulement les deux comparaisons : un
// NaN echoue les deux comparaisons donc passerait pour valide si on se
// contentait de les nier, et un 6.5 essais n'a pas de sens. La valeur vient du
// corps d'une requete HTTP, ou tout est possible.
function is_within_inclusive_bounds(
  value: number,
  bounds: Readonly<{ min: number; max: number }>,
): boolean {
  return Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max;
}
