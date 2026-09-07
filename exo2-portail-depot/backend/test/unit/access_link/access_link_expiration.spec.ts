import { is_access_link_usable } from '../../../src/domain/access_link';
import {
  REFERENCE_NOW,
  add_days,
  add_minutes,
  build_access_link,
} from '../../fixtures/domain_builders';

describe('is_access_link_usable', () => {
  it('[10] un lien consulte strictement avant son echeance est utilisable', () => {
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, 7) });
    const now = add_minutes(link.expires_at, -1);

    expect(is_access_link_usable(link, now)).toBe(true);
  });

  it('[10] un lien consulte strictement apres son echeance est inutilisable', () => {
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, 7) });
    const now = add_minutes(link.expires_at, 1);

    expect(is_access_link_usable(link, now)).toBe(false);
  });

  it('[10][15] le cas limite ou l\'horloge vaut exactement expires_at est deja considere expire', () => {
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, 7) });
    const now = link.expires_at;

    expect(is_access_link_usable(link, now)).toBe(false);
  });

  it('[15] un lien bloque n\'est jamais utilisable, meme strictement avant son echeance', () => {
    const link = build_access_link({
      status: 'blocked',
      expires_at: add_days(REFERENCE_NOW, 7),
    });
    const now = add_minutes(link.expires_at, -1);

    expect(is_access_link_usable(link, now)).toBe(false);
  });

  it('[15] un lien revoque n\'est jamais utilisable, meme strictement avant son echeance', () => {
    const link = build_access_link({
      status: 'revoked',
      expires_at: add_days(REFERENCE_NOW, 7),
      revoked_at: REFERENCE_NOW,
    });
    const now = add_minutes(link.expires_at, -1);

    expect(is_access_link_usable(link, now)).toBe(false);
  });

  it('[15] seule la date passee en parametre change le resultat pour un meme lien, jamais l\'horloge globale', () => {
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, 7) });
    const now_before = add_minutes(link.expires_at, -1);
    const now_after = add_minutes(link.expires_at, 1);

    expect(is_access_link_usable(link, now_before)).toBe(true);
    expect(is_access_link_usable(link, now_after)).toBe(false);
  });
});
