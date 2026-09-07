import { compute_presigned_upload_expiry } from '../../../src/domain/presigned_upload';
import {
  REFERENCE_NOW,
  add_minutes,
  build_access_link,
  build_deposit_session,
} from '../../fixtures/domain_builders';

describe('compute_presigned_upload_expiry', () => {
  it('quand la duree demandee tient dans la session, l\'echeance vaut now + duree demandee', () => {
    const session = build_deposit_session({
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = REFERENCE_NOW;

    const expiry = compute_presigned_upload_expiry(session, 10 * 60, now);

    expect(expiry).toEqual(add_minutes(REFERENCE_NOW, 10));
  });

  it('[12] quand la duree demandee depasse l\'echeance de la session, le resultat est EXACTEMENT l\'echeance de la session : un presigned ne survit jamais a la session qui l\'a demande', () => {
    const session = build_deposit_session({
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = REFERENCE_NOW;

    const expiry = compute_presigned_upload_expiry(session, 60 * 60, now);

    expect(expiry).toEqual(session.expires_at);
  });

  it('quand la session est deja expiree, l\'echeance calculee reste bornee a expires_at et ne repart jamais dans le futur au-dela', () => {
    const session = build_deposit_session({
      created_at: REFERENCE_NOW,
      expires_at: add_minutes(REFERENCE_NOW, 30),
    });
    const now = add_minutes(REFERENCE_NOW, 45);

    const expiry = compute_presigned_upload_expiry(session, 10 * 60, now);

    expect(expiry).toEqual(session.expires_at);
  });

  it('chaine complete des trois horloges : lien a 5 min, session demandee a 30 min, presigned demande a 15 min -> l\'echeance finale reste celle du lien', () => {
    const link = build_access_link({ expires_at: add_minutes(REFERENCE_NOW, 5) });
    const now = REFERENCE_NOW;

    // La session est bornee par le lien : son expires_at devient celui du lien.
    const session = build_deposit_session({
      access_link_id: link.id,
      created_at: REFERENCE_NOW,
      expires_at: link.expires_at,
    });

    const expiry = compute_presigned_upload_expiry(session, 15 * 60, now);

    expect(expiry).toEqual(link.expires_at);
  });
});
