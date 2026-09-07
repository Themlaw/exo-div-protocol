import {
  validate_security_policy,
  DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_BOUNDS,
  type SecurityPolicy,
} from '../../../src/domain/security_policy';

describe('validate_security_policy', () => {
  it('[31] ne produit aucune violation pour la politique par défaut', () => {
    const violations = validate_security_policy(DEFAULT_SECURITY_POLICY);

    expect(violations).toEqual([]);
  });

  it('[31] accepte les valeurs exactement aux bornes min et max (limites inclusives)', () => {
    const at_min_policy: SecurityPolicy = {
      max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.min,
      link_lifetime_days: SECURITY_POLICY_BOUNDS.link_lifetime_days.min,
      pin_length: SECURITY_POLICY_BOUNDS.pin_length.min,
    };
    const at_max_policy: SecurityPolicy = {
      max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.max,
      link_lifetime_days: SECURITY_POLICY_BOUNDS.link_lifetime_days.max,
      pin_length: SECURITY_POLICY_BOUNDS.pin_length.max,
    };

    expect(validate_security_policy(at_min_policy)).toEqual([]);
    expect(validate_security_policy(at_max_policy)).toEqual([]);
  });

  it('[31] signale max_pin_attempts_out_of_bounds en dessous du min', () => {
    const policy: SecurityPolicy = {
      ...DEFAULT_SECURITY_POLICY,
      max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.min - 1,
    };

    expect(validate_security_policy(policy)).toContain(
      'max_pin_attempts_out_of_bounds',
    );
  });

  it('[31] signale max_pin_attempts_out_of_bounds au dessus du max', () => {
    const policy: SecurityPolicy = {
      ...DEFAULT_SECURITY_POLICY,
      max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.max + 1,
    };

    expect(validate_security_policy(policy)).toContain(
      'max_pin_attempts_out_of_bounds',
    );
  });

  it('[31] signale link_lifetime_days_out_of_bounds en dessous du min', () => {
    const policy: SecurityPolicy = {
      ...DEFAULT_SECURITY_POLICY,
      link_lifetime_days: SECURITY_POLICY_BOUNDS.link_lifetime_days.min - 1,
    };

    expect(validate_security_policy(policy)).toContain(
      'link_lifetime_days_out_of_bounds',
    );
  });

  it('[31] signale link_lifetime_days_out_of_bounds au dessus du max', () => {
    const policy: SecurityPolicy = {
      ...DEFAULT_SECURITY_POLICY,
      link_lifetime_days: SECURITY_POLICY_BOUNDS.link_lifetime_days.max + 1,
    };

    expect(validate_security_policy(policy)).toContain(
      'link_lifetime_days_out_of_bounds',
    );
  });

  it('[31] signale pin_length_out_of_bounds en dessous du min', () => {
    const policy: SecurityPolicy = {
      ...DEFAULT_SECURITY_POLICY,
      pin_length: SECURITY_POLICY_BOUNDS.pin_length.min - 1,
    };

    expect(validate_security_policy(policy)).toContain('pin_length_out_of_bounds');
  });

  it('[31] signale pin_length_out_of_bounds au dessus du max', () => {
    const policy: SecurityPolicy = {
      ...DEFAULT_SECURITY_POLICY,
      pin_length: SECURITY_POLICY_BOUNDS.pin_length.max + 1,
    };

    expect(validate_security_policy(policy)).toContain('pin_length_out_of_bounds');
  });

  it('[31] produit plusieurs violations quand plusieurs paramètres sont invalides', () => {
    const policy: SecurityPolicy = {
      max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.max + 1,
      link_lifetime_days: SECURITY_POLICY_BOUNDS.link_lifetime_days.min - 1,
      pin_length: SECURITY_POLICY_BOUNDS.pin_length.max + 1,
    };

    const violations = validate_security_policy(policy);

    expect(violations).toContain('max_pin_attempts_out_of_bounds');
    expect(violations).toContain('link_lifetime_days_out_of_bounds');
    expect(violations).toContain('pin_length_out_of_bounds');
    expect(violations).toHaveLength(3);
  });
});
