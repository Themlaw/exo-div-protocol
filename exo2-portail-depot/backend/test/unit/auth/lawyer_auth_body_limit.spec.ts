import {
  MAXIMUM_LAWYER_AUTH_REQUEST_BODY_BYTES,
  find_oversized_request_body_violation,
} from '../../../src/auth/mount_lawyer_auth';

// Revue offensive du 2026-09-08, mesure sur l'application reelle : un POST de
// 201 Mo sur /sign-in/email a consomme 1,1 Gio de memoire et retenu la requete
// 5 min 36 s, pour repondre un 401 parfaitement normal. Le montage se fait en
// amont du routeur Nest, donc avant tout analyseur de corps, et better-call ne
// plafonne rien. `maxPasswordLength` ne s'applique qu'a l'inscription, fermee.
describe('find_oversized_request_body_violation', () => {
  it('un corps de taille normale passe', () => {
    expect(find_oversized_request_body_violation('POST', { 'content-length': '512' })).toBeNull();
  });

  it('un corps au-dela du plafond est refuse', () => {
    expect(
      find_oversized_request_body_violation('POST', {
        'content-length': String(MAXIMUM_LAWYER_AUTH_REQUEST_BODY_BYTES + 1),
      }),
    ).toBe('too_large');
  });

  it('le plafond exact est encore accepte', () => {
    expect(
      find_oversized_request_body_violation('POST', {
        'content-length': String(MAXIMUM_LAWYER_AUTH_REQUEST_BODY_BYTES),
      }),
    ).toBeNull();
  });

  it(
    "un corps annonce par morceaux, sans longueur, est refuse : sinon l'encodage " +
      "par morceaux contourne le plafond en n'annoncant simplement aucune taille",
    () => {
      expect(
        find_oversized_request_body_violation('POST', { 'transfer-encoding': 'chunked' }),
      ).toBe('length_required');
    },
  );

  // Corrige le 2026-09-09. Cette regle refusait AUSSI le POST qui n'annonce ni
  // longueur ni encodage — c'est-a-dire celui qui n'a pas de corps du tout, et
  // c'est exactement la forme de `POST /api/v1/auth/sign-out`. La deconnexion
  // repondait donc 411 sans jamais atteindre BetterAuth : la session restait
  // valide cote serveur, et le cookie qu'un attaquant detenait deja continuait
  // d'ouvrir le compte. Un plafond de taille n'a rien a plafonner quand il n'y
  // a pas d'octet.
  it("un POST qui n'annonce aucun corps est laisse passer : la deconnexion n'en a pas", () => {
    expect(find_oversized_request_body_violation('POST', {})).toBeNull();
    expect(find_oversized_request_body_violation('POST', { 'content-length': '0' })).toBeNull();
  });

  it('une longueur illisible est traitee comme absente, jamais comme nulle', () => {
    expect(find_oversized_request_body_violation('POST', { 'content-length': 'beaucoup' })).toBe(
      'length_required',
    );
    expect(find_oversized_request_body_violation('POST', { 'content-length': '-1' })).toBe(
      'length_required',
    );
  });

  it("une methode sans corps n'a pas a declarer de longueur", () => {
    expect(find_oversized_request_body_violation('GET', {})).toBeNull();
  });
});
