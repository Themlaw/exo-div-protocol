import { resolve_public_access_link_state } from '../../../src/domain/access_link';
import {
  build_access_link,
  REFERENCE_NOW,
  add_days,
} from '../../../test/fixtures/domain_builders';

describe('resolve_public_access_link_state', () => {
  it('[59] renvoie invalid pour un token inexistant (link null), indistinguable d un lien expiré', () => {
    const now = REFERENCE_NOW;

    const state = resolve_public_access_link_state(null, now);

    expect(state).toBe('invalid');
  });

  it('[59] renvoie invalid pour un lien expiré, la même valeur qu un token inexistant', () => {
    // `REFERENCE_NOW` et non `new Date()` : le lien etait date sur l'horloge
    // REELLE alors que la comparaison se fait sur l'horloge injectee, huit mois
    // plus tot. Le test decrivait un lien expire et en construisait un valide.
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, -1) });
    const now = REFERENCE_NOW;

    const state = resolve_public_access_link_state(link, now);

    expect(state).toBe('invalid');
  });

  it('[10] renvoie blocked pour un lien bloqué', () => {
    const link = build_access_link({ status: 'blocked', blocked_at: REFERENCE_NOW });
    const now = REFERENCE_NOW;

    const state = resolve_public_access_link_state(link, now);

    expect(state).toBe('blocked');
  });

  it('[10] renvoie active pour un lien actif consulté avant son échéance', () => {
    const link = build_access_link();
    const now = REFERENCE_NOW;

    const state = resolve_public_access_link_state(link, now);

    expect(state).toBe('active');
  });

  it('[10] renvoie invalid pour un lien révoqué', () => {
    const link = build_access_link({ status: 'revoked', revoked_at: REFERENCE_NOW });
    const now = REFERENCE_NOW;

    const state = resolve_public_access_link_state(link, now);

    expect(state).toBe('invalid');
  });
});
