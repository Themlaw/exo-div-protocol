import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECURITY_POLICY as BACKEND_DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_BOUNDS as BACKEND_SECURITY_POLICY_BOUNDS,
} from '../../../backend/src/domain/security_policy';
import {
  DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_BOUNDS,
} from '../../src/api/contracts';

// Le front ne peut pas IMPORTER le domaine backend dans son bundle : ce serait
// embarquer du Nest dans le navigateur. Il recopie donc les bornes, et ce test
// est le prix de la copie — il compare les deux valeurs a l'execution, et il
// echoue le jour ou l'une bouge sans l'autre.
//
// L'enjeu n'est pas cosmetique : un formulaire qui propose 30 jours quand le
// serveur en accepte 14 fabrique un refus que l'avocat ne comprend pas.
describe('Bornes de la politique de securite', () => {
  it('reprend exactement les valeurs par defaut du domaine backend', () => {
    expect(DEFAULT_SECURITY_POLICY).toEqual(BACKEND_DEFAULT_SECURITY_POLICY);
  });

  it('reprend exactement les bornes du domaine backend', () => {
    expect(SECURITY_POLICY_BOUNDS).toEqual(BACKEND_SECURITY_POLICY_BOUNDS);
  });

  it('propose des valeurs par defaut qui tiennent dans les bornes', () => {
    expect(DEFAULT_SECURITY_POLICY.max_pin_attempts).toBeGreaterThanOrEqual(
      SECURITY_POLICY_BOUNDS.max_pin_attempts.min,
    );
    expect(DEFAULT_SECURITY_POLICY.max_pin_attempts).toBeLessThanOrEqual(
      SECURITY_POLICY_BOUNDS.max_pin_attempts.max,
    );
    expect(DEFAULT_SECURITY_POLICY.link_lifetime_days).toBeGreaterThanOrEqual(
      SECURITY_POLICY_BOUNDS.link_lifetime_days.min,
    );
    expect(DEFAULT_SECURITY_POLICY.link_lifetime_days).toBeLessThanOrEqual(
      SECURITY_POLICY_BOUNDS.link_lifetime_days.max,
    );
    expect(DEFAULT_SECURITY_POLICY.pin_length).toBeGreaterThanOrEqual(
      SECURITY_POLICY_BOUNDS.pin_length.min,
    );
    expect(DEFAULT_SECURITY_POLICY.pin_length).toBeLessThanOrEqual(
      SECURITY_POLICY_BOUNDS.pin_length.max,
    );
  });
});
