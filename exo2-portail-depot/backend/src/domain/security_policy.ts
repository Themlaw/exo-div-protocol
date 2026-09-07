import { NotImplementedError } from './not_implemented';

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

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  max_pin_attempts: 5,
  link_lifetime_days: 7,
  pin_length: 4,
};

export type SecurityPolicyViolation =
  | 'max_pin_attempts_out_of_bounds'
  | 'link_lifetime_days_out_of_bounds'
  | 'pin_length_out_of_bounds';

export function validate_security_policy(
  _submitted_policy: SecurityPolicy,
): SecurityPolicyViolation[] {
  throw new NotImplementedError('validate_security_policy');
}
