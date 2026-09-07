import {
  parse_application_environment,
  InvalidEnvironmentError,
  MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH,
  MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH,
  REQUIRED_ENVIRONMENT_VARIABLES,
  type ApplicationEnvironment,
} from '../../../src/config/environment';

const VALID_RAW_ENVIRONMENT: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://portail:secret@localhost:5432/portail',
  ACCESS_LINK_TOKEN_PEPPER: 'p'.repeat(MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH),
  INTERNAL_STORAGE_WEBHOOK_SECRET: 's'.repeat(
    MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH,
  ),
  MINIO_ENDPOINT: 'http://minio:9000',
  MINIO_ROOT_USER: 'minio-root-user',
  MINIO_ROOT_PASSWORD: 'minio-root-password-value',
  DEMO_LAWYER_EMAIL: 'demo@example.test',
  DEMO_LAWYER_PASSWORD: 'demo-lawyer-password-value',
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
      minio_root_user: VALID_RAW_ENVIRONMENT.MINIO_ROOT_USER,
      minio_root_password: VALID_RAW_ENVIRONMENT.MINIO_ROOT_PASSWORD,
      demo_lawyer_email: VALID_RAW_ENVIRONMENT.DEMO_LAWYER_EMAIL,
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
      DATABASE_URL: 'http://localhost:5432/portail',
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

describe('coherence entre le contrat et le jeu de test', () => {
  // Sans ce controle, ajouter une variable a ENVIRONMENT_VARIABLE_NAMES sans
  // l'ajouter au fixture ferait passer les tests en ne la verifiant jamais.
  it('le jeu de variables valides couvre exactement REQUIRED_ENVIRONMENT_VARIABLES', () => {
    expect(Object.keys(VALID_RAW_ENVIRONMENT).sort()).toEqual(
      [...REQUIRED_ENVIRONMENT_VARIABLES].sort(),
    );
  });
});
