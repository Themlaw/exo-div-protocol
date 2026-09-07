import {
  is_deposit_session_usable,
  open_client_deposit_session,
} from '../../../src/domain/deposit_session';
import {
  REFERENCE_NOW,
  add_days,
  add_minutes,
  build_access_link,
  build_deposit_session,
} from '../../fixtures/domain_builders';

describe('open_client_deposit_session', () => {
  it('quand la duree demandee tient largement avant l\'echeance du lien, expires_at vaut created_at + duree demandee', () => {
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, 7) });
    const now = REFERENCE_NOW;

    const session = open_client_deposit_session(link, 30 * 60, now);

    expect(session.created_at).toEqual(REFERENCE_NOW);
    expect(session.expires_at).toEqual(add_minutes(REFERENCE_NOW, 30));
  });

  it('[13] quand le lien expire dans 5 min et qu\'on demande une session de 30 min, expires_at de la session est EXACTEMENT celle du lien : les durees se bornent, elles ne s\'additionnent pas', () => {
    const link = build_access_link({ expires_at: add_minutes(REFERENCE_NOW, 5) });
    const now = REFERENCE_NOW;

    const session = open_client_deposit_session(link, 30 * 60, now);

    expect(session.expires_at).toEqual(link.expires_at);
  });
});

describe('is_deposit_session_usable', () => {
  it('[11] une session dont l\'echeance propre court encore mais dont le lien a expire est refusee avec access_link_no_longer_usable', () => {
    const link = build_access_link({ expires_at: add_minutes(REFERENCE_NOW, 5) });
    const session = build_deposit_session({
      access_link_id: link.id,
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = add_minutes(REFERENCE_NOW, 10);

    const result = is_deposit_session_usable(session, link, now);

    expect(result).toEqual({ usable: false, rejection_reason: 'access_link_no_longer_usable' });
  });

  it('[14] une session par ailleurs valide dont le lien a ete revoque entre-temps est refusee au prochain appel', () => {
    const link = build_access_link({
      status: 'revoked',
      revoked_at: add_minutes(REFERENCE_NOW, 1),
      expires_at: add_days(REFERENCE_NOW, 7),
    });
    const session = build_deposit_session({
      access_link_id: link.id,
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = add_minutes(REFERENCE_NOW, 2);

    const result = is_deposit_session_usable(session, link, now);

    expect(result).toEqual({ usable: false, rejection_reason: 'access_link_no_longer_usable' });
  });

  it('une session dont le lien a ete bloque entre-temps est refusee', () => {
    const link = build_access_link({
      status: 'blocked',
      expires_at: add_days(REFERENCE_NOW, 7),
    });
    const session = build_deposit_session({
      access_link_id: link.id,
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = add_minutes(REFERENCE_NOW, 2);

    const result = is_deposit_session_usable(session, link, now);

    expect(result).toEqual({ usable: false, rejection_reason: 'access_link_no_longer_usable' });
  });

  it('une session expiree sur un lien encore valide est refusee avec session_expired', () => {
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, 7) });
    const session = build_deposit_session({
      access_link_id: link.id,
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = add_minutes(REFERENCE_NOW, 31);

    const result = is_deposit_session_usable(session, link, now);

    expect(result).toEqual({ usable: false, rejection_reason: 'session_expired' });
  });

  it('[39] une session par ailleurs parfaitement valide dont access_link_id ne correspond pas au lien fourni est refusee avec session_belongs_to_another_link', () => {
    const link = build_access_link({ id: 'link-Y', expires_at: add_days(REFERENCE_NOW, 7) });
    const session = build_deposit_session({
      access_link_id: 'link-X',
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = add_minutes(REFERENCE_NOW, 2);

    const result = is_deposit_session_usable(session, link, now);

    expect(result).toEqual({ usable: false, rejection_reason: 'session_belongs_to_another_link' });
  });

  it('une session valide sur un lien valide est utilisable, rejection_reason a null', () => {
    const link = build_access_link({ expires_at: add_days(REFERENCE_NOW, 7) });
    const session = build_deposit_session({
      access_link_id: link.id,
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = add_minutes(REFERENCE_NOW, 2);

    const result = is_deposit_session_usable(session, link, now);

    expect(result).toEqual({ usable: true, rejection_reason: null });
  });
});
