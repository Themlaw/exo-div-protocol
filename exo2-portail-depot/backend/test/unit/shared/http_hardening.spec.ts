import {
  apply_http_hardening,
  build_security_response_headers,
  STRICT_TRANSPORT_SECURITY_MAX_AGE_SECONDS,
} from '../../../src/shared/http_hardening';

interface FakeExpressApplication {
  disabled: readonly string[];
  disable(setting: string): void;
  use(middleware: unknown): void;
}

function build_fake_express_application(): FakeExpressApplication {
  const disabled: string[] = [];
  return {
    disabled,
    disable(setting: string): void {
      disabled.push(setting);
    },
    use(): void {},
  };
}

// Revue offensive du 2026-09-08 : toutes les reponses portaient
// `X-Powered-By: Express`. Divulgation gratuite de la pile, qui oriente le choix
// des exploits avant meme la premiere tentative.
describe('apply_http_hardening', () => {
  it("l'en-tete qui annonce la pile est desactive", () => {
    const application = build_fake_express_application();

    apply_http_hardening(application as never, 'production');

    expect(application.disabled).toContain('x-powered-by');
  });
});

describe('build_security_response_headers', () => {
  const production_headers: Readonly<Record<string, string>> =
    build_security_response_headers('production');

  it(
    "aucun referent n'est transmis : le lien client porte son jeton DANS l'URL, et le " +
      'referent le livrerait a tout tiers que la page contacte',
    () => {
      expect(production_headers['referrer-policy']).toBe('no-referrer');
    },
  );

  it('le navigateur ne devine pas le type : un fichier depose ne doit pas etre execute comme une page', () => {
    expect(production_headers['x-content-type-options']).toBe('nosniff');
  });

  it('la mise en cadre est refusee, par les deux mecanismes', () => {
    expect(production_headers['x-frame-options']).toBe('DENY');
    expect(production_headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it("la politique de contenu est fermee par defaut : l'API ne sert aucune ressource a charger", () => {
    expect(production_headers['content-security-policy']).toContain("default-src 'none'");
    expect(production_headers['content-security-policy']).toContain("base-uri 'none'");
    expect(production_headers['content-security-policy']).toContain("form-action 'none'");
  });

  it('HTTPS est impose pour les visites suivantes, sans preload', () => {
    expect(production_headers['strict-transport-security']).toBe(
      `max-age=${STRICT_TRANSPORT_SECURITY_MAX_AGE_SECONDS}; includeSubDomains`,
    );
    expect(production_headers['strict-transport-security']).not.toContain('preload');
  });

  it.each(['development', 'test'] as const)(
    "hors production (%s), HSTS n'est pas envoye : il epinglerait l'hote entier, localhost " +
      'compris, et casserait les autres services en clair du poste',
    (node_environment) => {
      expect(
        build_security_response_headers(node_environment)['strict-transport-security'],
      ).toBeUndefined();
    },
  );

  it(
    "ni cache ni disposition dans le lot global : ces deux en-tetes dependent de CE QUE la " +
      'reponse contient, et les poser partout casserait le cache des ressources du front',
    () => {
      expect(production_headers['cache-control']).toBeUndefined();
      expect(production_headers['content-disposition']).toBeUndefined();
    },
  );
});
