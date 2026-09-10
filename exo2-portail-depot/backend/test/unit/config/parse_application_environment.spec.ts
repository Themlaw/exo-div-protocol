import {
  LAWYER_PASSWORD_LENGTH_BOUNDS,
  MAXIMUM_LAWYER_EMAIL_LENGTH,
} from '../../../src/shared/lawyer_credentials';
import {
  parse_application_environment,
  InvalidEnvironmentError,
  DEFAULT_HTTP_PORT,
  DEFAULT_WORKER_METRICS_PORT,
  MINIMUM_LAWYER_AUTH_SECRET_LENGTH,
  DEFAULT_BETTER_AUTH_SECRET,
  MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH,
  MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH,
  REQUIRED_ENVIRONMENT_VARIABLES,
  FORBIDDEN_PRODUCTION_PLACEHOLDER_FRAGMENTS,
  MINIO_DEFAULT_ROOT_CREDENTIAL,
  type ApplicationEnvironment,
  type EnvironmentViolation,
} from '../../../src/config/environment';

const VALID_RAW_ENVIRONMENT: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://portail:mot-de-passe-genere@postgres:5432/portail',
  ACCESS_LINK_TOKEN_PEPPER: 'p'.repeat(MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH),
  INTERNAL_STORAGE_WEBHOOK_SECRET: 's'.repeat(
    MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH,
  ),
  MINIO_ENDPOINT: 'http://minio:9000',
  CLAMAV_ENDPOINT: 'tcp://clamav:3310',
  MINIO_ROOT_USER: 'portail-minio-root',
  MINIO_ROOT_PASSWORD: 'f'.repeat(64),
  DEMO_LAWYER_EMAIL: 'avocat@cabinet-demonstration.fr',
  TRUSTED_PROXY_HOP_COUNT: '1',
  PUBLIC_BASE_URL: 'https://portail.cabinet-demonstration.fr',
  BETTER_AUTH_SECRET: 'a'.repeat(MINIMUM_LAWYER_AUTH_SECRET_LENGTH),
  DEMO_LAWYER_PASSWORD: 'cheval batterie agrafe correct girafe',
};

function raw_environment_without(
  ...variables_to_remove: readonly string[]
): Readonly<Record<string, string | undefined>> {
  const raw_environment: Record<string, string | undefined> = {
    ...VALID_RAW_ENVIRONMENT,
  };
  for (const variable of variables_to_remove) {
    delete raw_environment[variable];
  }
  return raw_environment;
}

describe('parse_application_environment', () => {
  it('un environnement complet et valide produit un ApplicationEnvironment dont chaque champ est correctement mappe', () => {
    const application_environment: ApplicationEnvironment = parse_application_environment(
      VALID_RAW_ENVIRONMENT,
    );

    expect(application_environment).toEqual<ApplicationEnvironment>({
      node_environment: 'production',
      database_url: VALID_RAW_ENVIRONMENT.DATABASE_URL,
      access_link_token_pepper: VALID_RAW_ENVIRONMENT.ACCESS_LINK_TOKEN_PEPPER,
      internal_storage_webhook_secret:
        VALID_RAW_ENVIRONMENT.INTERNAL_STORAGE_WEBHOOK_SECRET,
      minio_endpoint: VALID_RAW_ENVIRONMENT.MINIO_ENDPOINT,
      clamav_endpoint: VALID_RAW_ENVIRONMENT.CLAMAV_ENDPOINT,
      minio_root_user: VALID_RAW_ENVIRONMENT.MINIO_ROOT_USER,
      minio_root_password: VALID_RAW_ENVIRONMENT.MINIO_ROOT_PASSWORD,
      demo_lawyer_email: VALID_RAW_ENVIRONMENT.DEMO_LAWYER_EMAIL,
      trusted_proxy_hop_count: 1,
      public_base_url: VALID_RAW_ENVIRONMENT.PUBLIC_BASE_URL,
      lawyer_auth_secret: VALID_RAW_ENVIRONMENT.BETTER_AUTH_SECRET,
      http_port: DEFAULT_HTTP_PORT,
      worker_metrics_port: DEFAULT_WORKER_METRICS_PORT,
      demo_lawyer_password: VALID_RAW_ENVIRONMENT.DEMO_LAWYER_PASSWORD,
    });
  });

  it.each(REQUIRED_ENVIRONMENT_VARIABLES)(
    '[22] la variable requise manquante %s produit une InvalidEnvironmentError dont violations la porte avec reason missing',
    (missing_variable: string) => {
      const raw_environment = raw_environment_without(missing_variable);

      expect(() => parse_application_environment(raw_environment)).toThrow(
        InvalidEnvironmentError,
      );

      try {
        parse_application_environment(raw_environment);
        throw new Error('parse_application_environment aurait du lever');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(InvalidEnvironmentError);
        expect((error as InvalidEnvironmentError).violations).toContainEqual({
          variable: missing_variable,
          reason: 'missing',
        });
      }
    },
  );

  it("plusieurs variables manquantes produisent PLUSIEURS violations en une seule erreur, pas une erreur par variable : au demarrage on veut la liste complete de ce qui manque, pas la decouvrir une par une", () => {
    const raw_environment = raw_environment_without('DATABASE_URL', 'MINIO_ENDPOINT');

    try {
      parse_application_environment(raw_environment);
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      const violations = (error as InvalidEnvironmentError).violations;
      expect(violations).toContainEqual({ variable: 'DATABASE_URL', reason: 'missing' });
      expect(violations).toContainEqual({ variable: 'MINIO_ENDPOINT', reason: 'missing' });
      expect(violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('une chaine vide compte comme manquante, pas comme valide', () => {
    const raw_environment: Readonly<Record<string, string | undefined>> = {
      ...VALID_RAW_ENVIRONMENT,
      DEMO_LAWYER_EMAIL: '',
    };

    try {
      parse_application_environment(raw_environment);
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as InvalidEnvironmentError).violations).toContainEqual({
        variable: 'DEMO_LAWYER_EMAIL',
        reason: 'missing',
      });
    }
  });

  it('un poivre tronque annule l\'interet du HMAC : plus court que MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH il produit une violation malformed', () => {
    const raw_environment: Readonly<Record<string, string | undefined>> = {
      ...VALID_RAW_ENVIRONMENT,
      ACCESS_LINK_TOKEN_PEPPER: 'p'.repeat(
        MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH - 1,
      ),
    };

    try {
      parse_application_environment(raw_environment);
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as InvalidEnvironmentError).violations).toContainEqual({
        variable: 'ACCESS_LINK_TOKEN_PEPPER',
        reason: 'malformed',
      });
    }
  });

  it('un poivre exactement a la longueur minimale est accepte', () => {
    const raw_environment: Readonly<Record<string, string | undefined>> = {
      ...VALID_RAW_ENVIRONMENT,
      ACCESS_LINK_TOKEN_PEPPER: 'p'.repeat(MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH),
  INTERNAL_STORAGE_WEBHOOK_SECRET: 's'.repeat(
    MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH,
  ),
    };

    expect(() => parse_application_environment(raw_environment)).not.toThrow();
  });

  it('un node_environment inconnu (ni development, ni test, ni production) produit une violation malformed', () => {
    const raw_environment: Readonly<Record<string, string | undefined>> = {
      ...VALID_RAW_ENVIRONMENT,
      NODE_ENV: 'staging',
    };

    try {
      parse_application_environment(raw_environment);
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as InvalidEnvironmentError).violations).toContainEqual({
        variable: 'NODE_ENV',
        reason: 'malformed',
      });
    }
  });

  it("une database_url qui n'est pas une URL postgres produit une violation malformed", () => {
    const raw_environment: Readonly<Record<string, string | undefined>> = {
      ...VALID_RAW_ENVIRONMENT,
      DATABASE_URL: 'http://postgres:5432/portail',
    };

    try {
      parse_application_environment(raw_environment);
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as InvalidEnvironmentError).violations).toContainEqual({
        variable: 'DATABASE_URL',
        reason: 'malformed',
      });
    }
  });

  it("le mot de passe de demonstration n'apparait jamais dans le message de l'erreur : c'est un message qui finira dans les logs de demarrage", () => {
    const raw_environment = raw_environment_without('MINIO_ENDPOINT');

    try {
      parse_application_environment(raw_environment);
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      const message = (error as InvalidEnvironmentError).message;
      expect(message).not.toContain(VALID_RAW_ENVIRONMENT.DEMO_LAWYER_PASSWORD);
      expect(message).not.toContain(VALID_RAW_ENVIRONMENT.MINIO_ROOT_PASSWORD);
      expect(message).not.toContain(VALID_RAW_ENVIRONMENT.ACCESS_LINK_TOKEN_PEPPER);
    }
  });
});

function violations_of(
  raw_environment: Readonly<Record<string, string | undefined>>,
): readonly { variable: string; reason: string }[] {
  try {
    parse_application_environment(raw_environment);
    throw new Error('parse_application_environment aurait du lever');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    return (error as InvalidEnvironmentError).violations;
  }
}

function raw_environment_with(
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  return { ...VALID_RAW_ENVIRONMENT, ...overrides };
}

// Une valeur de developpement qui atteint la production est un secret que tout
// le monde connait. Ces controles ne se declenchent qu'en production : les
// appliquer partout rendrait le poste de developpement inutilisable.
describe('valeurs de developpement interdites en production', () => {
  it("[c] minioadmin, l'identifiant par defaut documente de MinIO, est refuse sur MINIO_ROOT_USER", () => {
    expect(
      violations_of(raw_environment_with({ MINIO_ROOT_USER: MINIO_DEFAULT_ROOT_CREDENTIAL })),
    ).toContainEqual({
      variable: 'MINIO_ROOT_USER',
      reason: 'development_value_in_production',
    });
  });

  it('[c] minioadmin est egalement refuse sur MINIO_ROOT_PASSWORD', () => {
    expect(
      violations_of(raw_environment_with({ MINIO_ROOT_PASSWORD: MINIO_DEFAULT_ROOT_CREDENTIAL })),
    ).toContainEqual({
      variable: 'MINIO_ROOT_PASSWORD',
      reason: 'development_value_in_production',
    });
  });

  // Chaque fragment est teste NOYE dans une valeur par ailleurs credible : c'est
  // le contournement reel — personne n'ecrit `changeme`, on ecrit `changeme1`.
  it.each(FORBIDDEN_PRODUCTION_PLACEHOLDER_FRAGMENTS)(
    '[d] le fragment %s est refuse meme noye dans une valeur plus longue',
    (fragment: string) => {
      expect(
        violations_of(
          raw_environment_with({ DEMO_LAWYER_PASSWORD: `prefixe-${fragment}-2026-suffixe` }),
        ),
      ).toContainEqual({
        variable: 'DEMO_LAWYER_PASSWORD',
        reason: 'development_value_in_production',
      });
    },
  );

  it('[d] la comparaison est insensible a la casse et aux espaces : ChangeMe est aussi mauvais que changeme', () => {
    expect(
      violations_of(raw_environment_with({ MINIO_ROOT_PASSWORD: '  ChangeMe-2026  ' })),
    ).toContainEqual({
      variable: 'MINIO_ROOT_PASSWORD',
      reason: 'development_value_in_production',
    });
  });

  it.each([
    'demo@example.test',
    'demo@example.com',
    'demo@cabinet.local',
    'demo@cabinet.invalid',
  ])('[e] un email de demonstration en %s est refuse', (email: string) => {
    expect(violations_of(raw_environment_with({ DEMO_LAWYER_EMAIL: email }))).toContainEqual({
      variable: 'DEMO_LAWYER_EMAIL',
      reason: 'development_value_in_production',
    });
  });

  // En production, ces adresses sont des noms de service Docker. Un localhost
  // trahit un .env de developpement recopie tel quel.
  it.each([
    ['DATABASE_URL', 'postgres://portail:secret@localhost:5432/portail'],
    ['DATABASE_URL', 'postgres://portail:secret@127.0.0.1:5432/portail'],
    ['MINIO_ENDPOINT', 'http://localhost:9000'],
    ['MINIO_ENDPOINT', 'http://127.0.0.1:9000'],
  ])('[f] %s pointant sur %s est refuse', (variable: string, value: string) => {
    expect(violations_of(raw_environment_with({ [variable]: value }))).toContainEqual({
      variable,
      reason: 'development_value_in_production',
    });
  });

  it("[g] hors production, aucun de ces controles ne se declenche : le poste de developpement doit rester utilisable", () => {
    const development_environment: Readonly<Record<string, string | undefined>> =
      raw_environment_with({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://portail:portail@localhost:5432/portail',
        MINIO_ENDPOINT: 'http://localhost:9000',
        MINIO_ROOT_USER: MINIO_DEFAULT_ROOT_CREDENTIAL,
        MINIO_ROOT_PASSWORD: MINIO_DEFAULT_ROOT_CREDENTIAL,
        DEMO_LAWYER_EMAIL: 'demo@example.test',
        DEMO_LAWYER_PASSWORD: 'changeme-en-developpement',
      });

    expect(() => parse_application_environment(development_environment)).not.toThrow();
  });

  it("[h] la violation nomme la variable et la raison, jamais la valeur fautive", () => {
    const forbidden_value = MINIO_DEFAULT_ROOT_CREDENTIAL;
    const raw_environment = raw_environment_with({ MINIO_ROOT_PASSWORD: forbidden_value });

    try {
      parse_application_environment(raw_environment);
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      const invalid_environment_error = error as InvalidEnvironmentError;
      expect(invalid_environment_error.message).not.toContain(forbidden_value);
      expect(JSON.stringify(invalid_environment_error.violations)).not.toContain(forbidden_value);
    }
  });
});

// Sans ces controles au demarrage, un DEMO_LAWYER_PASSWORD de quatre caracteres
// passait le parsing et n'echouait qu'au moment du seed, loin de sa cause.
describe('les regles sur les identifiants avocat sont appliquees des le demarrage', () => {
  it.each([
    ['trop court d un caractere', 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.min - 1)],
    ['trop long d un caractere', 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.max + 1)],
  ])('un DEMO_LAWYER_PASSWORD %s produit une violation malformed', (_label: string, value: string) => {
    expect(violations_of(raw_environment_with({ DEMO_LAWYER_PASSWORD: value }))).toContainEqual({
      variable: 'DEMO_LAWYER_PASSWORD',
      reason: 'malformed',
    });
  });

  it.each([
    ['sans arobase', 'avocat.cabinet.fr'],
    ['sans domaine pointe', 'avocat@cabinet'],
    ['plus long que la borne', `${'a'.repeat(MAXIMUM_LAWYER_EMAIL_LENGTH)}@cabinet.fr`],
  ])('un DEMO_LAWYER_EMAIL %s produit une violation malformed', (_label: string, value: string) => {
    expect(violations_of(raw_environment_with({ DEMO_LAWYER_EMAIL: value }))).toContainEqual({
      variable: 'DEMO_LAWYER_EMAIL',
      reason: 'malformed',
    });
  });

  // Le point de la source unique : si quelqu'un change la borne d'un cote sans
  // l'autre, ce test ne le verra pas — mais il n'y a plus deux cotes.
  it('les bornes appliquees ici sont exactement celles de shared/lawyer_credentials', () => {
    const exactly_minimum: string = 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.min);
    const exactly_maximum: string = 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.max);

    expect(() =>
      parse_application_environment(
        raw_environment_with({ DEMO_LAWYER_PASSWORD: exactly_minimum }),
      ),
    ).not.toThrow();
    expect(() =>
      parse_application_environment(
        raw_environment_with({ DEMO_LAWYER_PASSWORD: exactly_maximum }),
      ),
    ).not.toThrow();
  });
});

// Les 32 caracteres precedents valaient 128 bits pour un poivre genere en
// hexadecimal, alors qu'une clef HMAC-SHA256 merite la taille de sortie du
// hache, soit 32 octets — donc 64 caracteres hex.
describe('longueur des secrets', () => {
  it.each([
    ['ACCESS_LINK_TOKEN_PEPPER', MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH],
    ['INTERNAL_STORAGE_WEBHOOK_SECRET', MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH],
  ])('%s exige au moins 64 caracteres hexadecimaux, soit 32 octets', (variable: string, minimum: number) => {
    expect(minimum).toBe(64);

    expect(
      violations_of(raw_environment_with({ [variable]: 'a'.repeat(minimum - 1) })),
    ).toContainEqual({ variable, reason: 'malformed' });

    expect(() =>
      parse_application_environment(raw_environment_with({ [variable]: 'a'.repeat(minimum) })),
    ).not.toThrow();
  });
});

// La revue de securite a montre que ce parametre — le plus sensible de la
// limitation par adresse — n'etait lu de NULLE PART, alors que
// parse_application_environment existe pour qu'aucune configuration dangereuse
// ne demarre. Un NaN faisait lever une TypeError sur chaque tentative de
// connexion, soit un deni de service total du login.
describe('[F4] TRUSTED_PROXY_HOP_COUNT est une variable a part entiere', () => {
  it.each([
    ['une valeur non numerique', 'abc'],
    ['un nombre fractionnaire', '1.5'],
    ['un nombre negatif', '-1'],
    ['une notation exponentielle', '1e3'],
    ['un espace', ' '],
    ['une valeur hexadecimale', '0x1'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('%s produit une violation malformed', (_label: string, value: string) => {
    expect(violations_of(raw_environment_with({ TRUSTED_PROXY_HOP_COUNT: value }))).toContainEqual({
      variable: 'TRUSTED_PROXY_HOP_COUNT',
      reason: 'malformed',
    });
  });

  // Zero est LEGITIME et doit passer : c'est le mode degrade de la VM
  // d'exercice, ou le passthrough SNI empeche le proxy frontal d'ajouter un
  // X-Forwarded-For. Le refuser forcerait a mentir sur la configuration.
  it.each(['0', '1', '2'])('%s est accepte', (value: string) => {
    expect(() =>
      parse_application_environment(raw_environment_with({ TRUSTED_PROXY_HOP_COUNT: value })),
    ).not.toThrow();
  });

  it('la valeur est rendue comme un nombre, pas comme une chaine', () => {
    const parsed = parse_application_environment(
      raw_environment_with({ TRUSTED_PROXY_HOP_COUNT: '2' }),
    );

    expect(parsed.trusted_proxy_hop_count).toBe(2);
  });
});

// Mesure lors de la revue : `postgres:` n'etant pas un schema « special » au
// sens WHATWG, `new URL()` ne canonicalise pas l'hote IPv4. Le controle
// n'attrapait donc que l'ecriture la plus naive de la boucle locale.
describe('[F7] les ecritures alternatives de la boucle locale sont refusees en production', () => {
  it.each([
    ['forme courte', 'postgres://portail:mdp@127.1:5432/portail'],
    ['entier 32 bits', 'postgres://portail:mdp@2130706433:5432/portail'],
    ['octal', 'postgres://portail:mdp@0177.0.0.1:5432/portail'],
    ['point final', 'postgres://portail:mdp@localhost.:5432/portail'],
    ['IPv4 mappee', 'postgres://portail:mdp@[::ffff:127.0.0.1]:5432/portail'],
    ['adresse nulle', 'postgres://portail:mdp@0.0.0.0:5432/portail'],
    ['autre adresse de la boucle', 'postgres://portail:mdp@127.0.0.2:5432/portail'],
  ])('DATABASE_URL en %s est refuse', (_label: string, value: string) => {
    expect(violations_of(raw_environment_with({ DATABASE_URL: value }))).toContainEqual({
      variable: 'DATABASE_URL',
      reason: 'development_value_in_production',
    });
  });

  it.each([
    ['forme courte', 'http://127.1:9000'],
    ['entier 32 bits', 'http://2130706433:9000'],
    ['point final', 'http://localhost.:9000'],
    ['IPv4 mappee', 'http://[::ffff:127.0.0.1]:9000'],
    ['adresse nulle', 'http://0.0.0.0:9000'],
  ])('MINIO_ENDPOINT en %s est refuse', (_label: string, value: string) => {
    expect(violations_of(raw_environment_with({ MINIO_ENDPOINT: value }))).toContainEqual({
      variable: 'MINIO_ENDPOINT',
      reason: 'development_value_in_production',
    });
  });

  it('un nom de service Docker reste accepte : c est la configuration nominale', () => {
    expect(() =>
      parse_application_environment(
        raw_environment_with({
          DATABASE_URL: 'postgres://portail:mdp@postgres:5432/portail',
          MINIO_ENDPOINT: 'http://minio:9000',
  CLAMAV_ENDPOINT: 'tcp://clamav:3310',
        }),
      ),
    ).not.toThrow();
  });
});

// DATABASE_URL contient POSTGRES_PASSWORD en clair. Il n'etait passe qu'au
// crible de la boucle locale, jamais a celui des valeurs bidon : un
// POSTGRES_PASSWORD=changeme demarrait en production alors que le meme mot de
// passe sur MINIO_ROOT_PASSWORD etait refuse.
describe('[F8] le mot de passe contenu dans DATABASE_URL est passe au crible', () => {
  it.each(['changeme', 'password2026', 'motdepasse', 'secret-42'])(
    'un mot de passe Postgres %s est refuse en production',
    (postgres_password: string) => {
      expect(
        violations_of(
          raw_environment_with({
            DATABASE_URL: `postgres://portail:${postgres_password}@postgres:5432/portail`,
          }),
        ),
      ).toContainEqual({
        variable: 'DATABASE_URL',
        reason: 'development_value_in_production',
      });
    },
  );

  it("le mot de passe ne se retrouve jamais dans le message d'erreur", () => {
    const postgres_password = 'changeme-tres-reconnaissable';

    try {
      parse_application_environment(
        raw_environment_with({
          DATABASE_URL: `postgres://portail:${postgres_password}@postgres:5432/portail`,
        }),
      );
      throw new Error('parse_application_environment aurait du lever');
    } catch (error: unknown) {
      const invalid_environment_error = error as InvalidEnvironmentError;
      expect(invalid_environment_error.message).not.toContain(postgres_password);
      expect(JSON.stringify(invalid_environment_error.violations)).not.toContain(
        postgres_password,
      );
    }
  });

  it('hors production, un mot de passe Postgres faible reste accepte', () => {
    expect(() =>
      parse_application_environment(
        raw_environment_with({
          NODE_ENV: 'development',
          DATABASE_URL: 'postgres://portail:changeme@localhost:5432/portail',
        }),
      ),
    ).not.toThrow();
  });
});

describe('coherence entre le contrat et le jeu de test', () => {
  // Sans ce controle, ajouter une variable a ENVIRONMENT_VARIABLE_NAMES sans
  // l'ajouter au fixture ferait passer les tests en ne la verifiant jamais.
  it('le jeu de variables valides couvre exactement REQUIRED_ENVIRONMENT_VARIABLES', () => {
    expect(Object.keys(VALID_RAW_ENVIRONMENT).sort()).toEqual(
      [...REQUIRED_ENVIRONMENT_VARIABLES].sort(),
    );
  });
});

// PUBLIC_BASE_URL fixe l'origine de confiance de l'authentification : c'est
// elle qui decide quelles pages ont le droit de poster vers l'API, et le
// domaine sur lequel le cookie de session est pose. La deduire des en-tetes de
// la requete reviendrait a laisser le client designer sa propre origine de
// confiance.
describe('PUBLIC_BASE_URL', () => {
  function raw_environment_with_public_base_url(
    public_base_url: string,
    node_environment: string = 'production',
  ): Readonly<Record<string, string | undefined>> {
    return {
      ...VALID_RAW_ENVIRONMENT,
      NODE_ENV: node_environment,
      PUBLIC_BASE_URL: public_base_url,
    };
  }

  function violations_of(
    raw_environment: Readonly<Record<string, string | undefined>>,
  ): readonly EnvironmentViolation[] {
    try {
      parse_application_environment(raw_environment);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      return (error as InvalidEnvironmentError).violations;
    }
    throw new Error('parse_application_environment aurait du lever');
  }

  it.each([
    ['sans schema', 'portail.cabinet-demonstration.fr'],
    ['schema non http', 'ftp://portail.cabinet-demonstration.fr'],
    ['hote vide', 'https://'],
    ['chaine sans rapport', 'pas-une-url'],
  ])('une valeur %s est malformed', (_label: string, public_base_url: string) => {
    expect(violations_of(raw_environment_with_public_base_url(public_base_url))).toContainEqual({
      variable: 'PUBLIC_BASE_URL',
      reason: 'malformed',
    });
  });

  it(
    "une URL portant des identifiants est malformed : ils seraient recopies dans " +
      'les journaux et dans les URLs renvoyees au navigateur',
    () => {
      expect(
        violations_of(
          raw_environment_with_public_base_url('https://avocat:secret@portail.fr'),
        ),
      ).toContainEqual({ variable: 'PUBLIC_BASE_URL', reason: 'malformed' });
    },
  );

  it(
    "en production, http:// est une valeur de developpement : le cookie de session " +
      'ne peut pas etre pose en Secure, donc il voyage en clair',
    () => {
      expect(
        violations_of(
          raw_environment_with_public_base_url('http://portail.cabinet-demonstration.fr'),
        ),
      ).toContainEqual({
        variable: 'PUBLIC_BASE_URL',
        reason: 'development_value_in_production',
      });
    },
  );

  it.each([
    ['localhost', 'https://localhost'],
    ['boucle locale IPv4', 'https://127.0.0.1'],
    ['toutes interfaces', 'https://0.0.0.0'],
  ])(
    'en production, une base sur %s est une valeur de developpement',
    (_label: string, public_base_url: string) => {
      expect(violations_of(raw_environment_with_public_base_url(public_base_url))).toContainEqual({
        variable: 'PUBLIC_BASE_URL',
        reason: 'development_value_in_production',
      });
    },
  );

  it('hors production, http sur la boucle locale est accepte : c est le poste de developpement', () => {
    const application_environment: ApplicationEnvironment = parse_application_environment(
      raw_environment_with_public_base_url('http://localhost:3000', 'development'),
    );

    expect(application_environment.public_base_url).toBe('http://localhost:3000');
  });
});

// Les deux ports sont les seules variables facultatives : une installation qui
// ne les renseigne pas doit demarrer, les valeurs par defaut etant celles que le
// Dockerfile et le proxy connaissent deja.
describe('PORT', () => {
  function raw_environment_with_port(
    port: string | undefined,
  ): Readonly<Record<string, string | undefined>> {
    return { ...VALID_RAW_ENVIRONMENT, PORT: port };
  }

  function violations_for_port(port: string): readonly EnvironmentViolation[] {
    try {
      parse_application_environment(raw_environment_with_port(port));
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      return (error as InvalidEnvironmentError).violations;
    }
    throw new Error('parse_application_environment aurait du lever');
  }

  it('absente, le port vaut la valeur par defaut et le demarrage n est pas bloque', () => {
    expect(parse_application_environment(raw_environment_with_port(undefined)).http_port).toBe(
      DEFAULT_HTTP_PORT,
    );
  });

  it("vide, le port vaut aussi la valeur par defaut : une variable presente mais vide n'est pas un reglage", () => {
    expect(parse_application_environment(raw_environment_with_port('')).http_port).toBe(
      DEFAULT_HTTP_PORT,
    );
  });

  it('une valeur explicite est retenue telle quelle', () => {
    expect(parse_application_environment(raw_environment_with_port('8080')).http_port).toBe(8080);
  });

  it.each([
    ['non numerique', 'quatre-vingt'],
    ['decimal', '3000.5'],
    ['negatif', '-1'],
    ['notation exponentielle', '3e3'],
    ['espaces autour', ' 3000 '],
    ['hors borne haute', '65536'],
    ['zero', '0'],
  ])('une valeur %s est malformed plutot que silencieusement corrigee', (_label: string, port: string) => {
    expect(violations_for_port(port)).toContainEqual({ variable: 'PORT', reason: 'malformed' });
  });

  it(
    "un port privilegie est refuse : le conteneur tourne en uid 1000, le liage echouerait " +
      "sur un EACCES obscur au lieu d'un message de configuration",
    () => {
      expect(violations_for_port('80')).toContainEqual({
        variable: 'PORT',
        reason: 'malformed',
      });
    },
  );

  it("PORT ne figure pas parmi les variables requises : il a une valeur par defaut", () => {
    expect(REQUIRED_ENVIRONMENT_VARIABLES).not.toContain('PORT');
  });
});

// Le port sur lequel le travailleur expose ses metriques. Il ne sert aucune
// requete metier : ce port n'est publie que sur le reseau interne, et le
// collecteur est le seul a l'atteindre.
describe('WORKER_METRICS_PORT', () => {
  function raw_environment_with_worker_port(
    port: string | undefined,
  ): Readonly<Record<string, string | undefined>> {
    return { ...VALID_RAW_ENVIRONMENT, WORKER_METRICS_PORT: port };
  }

  function violations_for_worker_port(port: string): readonly EnvironmentViolation[] {
    try {
      parse_application_environment(raw_environment_with_worker_port(port));
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      return (error as InvalidEnvironmentError).violations;
    }
    throw new Error('parse_application_environment aurait du lever');
  }

  it('absente, le port vaut la valeur par defaut', () => {
    expect(
      parse_application_environment(raw_environment_with_worker_port(undefined))
        .worker_metrics_port,
    ).toBe(DEFAULT_WORKER_METRICS_PORT);
  });

  it('vide, le port vaut aussi la valeur par defaut', () => {
    expect(
      parse_application_environment(raw_environment_with_worker_port('')).worker_metrics_port,
    ).toBe(DEFAULT_WORKER_METRICS_PORT);
  });

  it('une valeur explicite est retenue telle quelle', () => {
    expect(
      parse_application_environment(raw_environment_with_worker_port('9101')).worker_metrics_port,
    ).toBe(9101);
  });

  it.each([
    ['non numerique', 'neuf-mille'],
    ['decimal', '9100.5'],
    ['negatif', '-1'],
    ['espaces autour', ' 9100 '],
    ['hors borne haute', '65536'],
    ['zero', '0'],
    ['privilegie', '80'],
  ])(
    'une valeur %s est malformed plutot que silencieusement corrigee',
    (_label: string, port: string) => {
      expect(violations_for_worker_port(port)).toContainEqual({
        variable: 'WORKER_METRICS_PORT',
        reason: 'malformed',
      });
    },
  );

  // Deux processus sur la meme machine : un travailleur qui ecouterait sur le
  // port de l'API ne demarrerait pas, et l'erreur serait un EADDRINUSE sans
  // rapport apparent avec la configuration.
  it("refuse le port deja pris par l'API", () => {
    expect(
      violations_for_worker_port(String(parse_application_environment(VALID_RAW_ENVIRONMENT).http_port)),
    ).toContainEqual({ variable: 'WORKER_METRICS_PORT', reason: 'malformed' });
  });

  it("WORKER_METRICS_PORT ne figure pas parmi les variables requises", () => {
    expect(REQUIRED_ENVIRONMENT_VARIABLES).not.toContain('WORKER_METRICS_PORT');
  });
});

// Revue offensive du 2026-09-08. Sans cette variable, BetterAuth retombe sur une
// constante publiee sur npm et LEVE a la premiere requete en production : le
// demarrage est vert, tous les journaux sont normaux, et le portail repond 500.
// C'est exactement la panne que ce parsing existe pour rendre impossible.
describe('BETTER_AUTH_SECRET', () => {
  function raw_environment_with_secret(
    secret: string | undefined,
    node_environment: string = 'production',
  ): Readonly<Record<string, string | undefined>> {
    return { ...VALID_RAW_ENVIRONMENT, NODE_ENV: node_environment, BETTER_AUTH_SECRET: secret };
  }

  function violations_of(
    raw_environment: Readonly<Record<string, string | undefined>>,
  ): readonly EnvironmentViolation[] {
    try {
      parse_application_environment(raw_environment);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      return (error as InvalidEnvironmentError).violations;
    }
    throw new Error('parse_application_environment aurait du lever');
  }

  it('figure parmi les variables requises', () => {
    expect(REQUIRED_ENVIRONMENT_VARIABLES).toContain('BETTER_AUTH_SECRET');
  });

  it('absente, le demarrage est refuse plutot que reporte a la premiere connexion', () => {
    expect(violations_of(raw_environment_with_secret(undefined))).toContainEqual({
      variable: 'BETTER_AUTH_SECRET',
      reason: 'missing',
    });
  });

  it('trop courte, elle est malformed : ce secret signe les cookies de session', () => {
    expect(
      violations_of(raw_environment_with_secret('a'.repeat(MINIMUM_LAWYER_AUTH_SECRET_LENGTH - 1))),
    ).toContainEqual({ variable: 'BETTER_AUTH_SECRET', reason: 'malformed' });
  });

  it(
    "la valeur par defaut de la bibliotheque est refusee explicitement : elle est publiee " +
      'sur npm, donc quiconque la connait peut forger un cookie de session',
    () => {
      expect(
        violations_of(raw_environment_with_secret(DEFAULT_BETTER_AUTH_SECRET)),
      ).toContainEqual({
        variable: 'BETTER_AUTH_SECRET',
        reason: 'development_value_in_production',
      });
    },
  );

  it('un secret bidon est refuse en production comme les autres', () => {
    expect(violations_of(raw_environment_with_secret('changeme-changeme-changeme-changeme-changeme-changeme-changeme-x'))).toContainEqual({
      variable: 'BETTER_AUTH_SECRET',
      reason: 'development_value_in_production',
    });
  });
});

// Revue offensive du 2026-09-08 : un chemin dans l'URL de base devient le
// `basePath` de BetterAuth et met TOUTES ses routes en 404. Panne totale et
// silencieuse — l'audit de demarrage annonce toujours ses trois routes ouvertes.
describe('PUBLIC_BASE_URL portant un chemin', () => {
  it.each([
    ['un chemin', 'https://portail.fr/candidat-12'],
    ['une requete', 'https://portail.fr/?x=1'],
    ['un fragment', 'https://portail.fr/#ancre'],
  ])('%s est malformed', (_label: string, public_base_url: string) => {
    try {
      parse_application_environment({ ...VALID_RAW_ENVIRONMENT, PUBLIC_BASE_URL: public_base_url });
    } catch (error: unknown) {
      expect((error as InvalidEnvironmentError).violations).toContainEqual({
        variable: 'PUBLIC_BASE_URL',
        reason: 'malformed',
      });
      return;
    }
    throw new Error('parse_application_environment aurait du lever');
  });

  it('la racine, avec ou sans slash final, reste acceptee', () => {
    for (const public_base_url of ['https://portail.fr', 'https://portail.fr/']) {
      expect(
        parse_application_environment({ ...VALID_RAW_ENVIRONMENT, PUBLIC_BASE_URL: public_base_url })
          .public_base_url,
      ).toBe(public_base_url);
    }
  });
});

// Revue offensive du 2026-09-08 : l'environnement rendait l'email brut, et le
// journal d'amorcage affichait « Audit.Demo@Cabinet.FR ». Aujourd'hui seule la
// couche de persistance normalise ; tout futur lecteur heriterait de la variante
// non normalisee, ce qui est precisement la faille de compteur decrite en memoire.
describe('DEMO_LAWYER_EMAIL est normalise a la sortie du parsing', () => {
  it('la casse est rabattue et les espaces retires', () => {
    const application_environment: ApplicationEnvironment = parse_application_environment({
      ...VALID_RAW_ENVIRONMENT,
      DEMO_LAWYER_EMAIL: '  Avocat@Cabinet-Demonstration.FR  ',
    });

    expect(application_environment.demo_lawyer_email).toBe('avocat@cabinet-demonstration.fr');
  });
});
