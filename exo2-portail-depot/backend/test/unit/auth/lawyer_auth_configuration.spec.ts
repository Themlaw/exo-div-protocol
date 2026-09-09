import { build_lawyer_auth, LAWYER_AUTH_SESSION_EXPIRY_SECONDS } from '../../../src/auth/lawyer_auth';
import { build_capturing_logger } from '../../helpers/capturing_logger';

const LAWYER_AUTH_SECRET = 'z'.repeat(64);

function build_auth_options(): Record<string, unknown> {
  const lawyer_auth = build_lawyer_auth({
    database: {} as never,
    password_hasher: {
      hash_plaintext_password: async (): Promise<string> => '',
      verify_plaintext_password: async (): Promise<boolean> => false,
    },
    public_base_url: 'https://portail.fr',
    node_environment: 'production',
    logger: build_capturing_logger(),
    lawyer_auth_secret: LAWYER_AUTH_SECRET,
  });

  return (lawyer_auth as unknown as { options: Record<string, unknown> }).options;
}

describe('configuration de BetterAuth', () => {
  // Revue offensive du 2026-09-08 : sans secret explicite, la bibliotheque
  // retombe sur une constante publiee sur npm.
  it('le secret de signature vient de la configuration, jamais d un defaut de bibliotheque', () => {
    expect(build_auth_options().secret).toBe(LAWYER_AUTH_SECRET);
  });

  it("l'expiration absolue de session est bien celle qu'on a decidee", () => {
    const session = build_auth_options().session as Record<string, unknown>;

    expect(session.expiresIn).toBe(LAWYER_AUTH_SESSION_EXPIRY_SECONDS);
    expect(session.disableSessionRefresh).toBe(true);
  });

  // Revue offensive du 2026-09-08 : par defaut, la bibliotheque plafonne
  // /sign-in a 3 requetes par 10 secondes et, faute de pouvoir identifier le
  // client, fait partager UN SEUL seau au monde entier. N'importe qui fermait
  // donc le portail a l'avocat legitime avec 0,3 requete par seconde. Relever
  // les bornes ne corrige pas ce defaut : avec un seau partage, tout plafond
  // fini refuse tout le monde, et une fenetre plus longue allonge la coupure.
  it('le limiteur de la bibliotheque est desactive : il ne saurait refuser que le legitime', () => {
    const rate_limit = build_auth_options().rateLimit as Record<string, unknown>;

    expect(rate_limit.enabled).toBe(false);
  });

  it(
    "aucune regle particuliere ne reintroduit un plafond : ce serait le meme defaut sous " +
      'un autre nom, et sur la route qui ferme le portail',
    () => {
      const rate_limit = build_auth_options().rateLimit as {
        customRules?: Record<string, unknown>;
      };

      expect(rate_limit.customRules).toBeUndefined();
    },
  );

  // Revue offensive du 2026-09-08 : sans gestionnaire, better-call ecrit
  // l'erreur avec un `console.error` brut, hors de notre journalisation.
  it('un gestionnaire d erreur est fourni, sinon la bibliotheque ecrit sur la console', () => {
    const on_api_error = build_auth_options().onAPIError as Record<string, unknown> | undefined;

    expect(on_api_error).toBeDefined();
    expect(typeof on_api_error?.onError).toBe('function');
  });
});
