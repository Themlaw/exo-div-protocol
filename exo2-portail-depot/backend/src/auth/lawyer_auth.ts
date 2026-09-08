import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { ApplicationDatabase } from '../db/database_connection';
import {
  auth_account,
  auth_session,
  auth_user,
  auth_verification,
} from '../db/schema/auth_schema';
import { LAWYER_PASSWORD_LENGTH_BOUNDS } from '../shared/lawyer_credentials';
import type { NodeEnvironment } from '../shared/node_environment';
import { LAWYER_AUTH_MOUNT_PATH } from './non_nest_route_declarations';
import type { LawyerPasswordHasher } from './lawyer_password_hasher';
import { build_lawyer_auth_logger } from './lawyer_auth_logging';
import type { ApplicationLogger } from '../shared/logging/application_logger';

export const LAWYER_AUTH: unique symbol = Symbol('LAWYER_AUTH');

// Expiration ABSOLUE de huit heures : la duree d'une journee de travail. Un
// poste laisse ouvert au cabinet le soir ne rouvre pas les pieces le lendemain.
export const LAWYER_AUTH_SESSION_EXPIRY_SECONDS = 8 * 60 * 60;

export interface LawyerAuthDependencies {
  database: ApplicationDatabase;
  password_hasher: LawyerPasswordHasher;
  public_base_url: string;
  node_environment: NodeEnvironment;
  logger: ApplicationLogger;
}

// Sans annotation de retour, contrairement au reste du depot : `betterAuth`
// rend un type parametre par l'objet d'options LITTERAL qui lui est passe, et
// l'annoter avec la forme large `Auth<BetterAuthOptions>` ne compile pas. Le
// type exact est donc publie juste apres, deduit de cette fonction.
export function build_lawyer_auth(dependencies: LawyerAuthDependencies) {
  return betterAuth({
    baseURL: dependencies.public_base_url,
    basePath: LAWYER_AUTH_MOUNT_PATH,
    // L'origine de confiance vient de la configuration de deploiement, jamais
    // des en-tetes de la requete : `Host` et `Origin` sont fournis par le
    // client, et les croire reviendrait a le laisser designer lui-meme
    // l'origine autorisee a poster vers l'API.
    trustedOrigins: [dependencies.public_base_url],
    database: drizzleAdapter(dependencies.database, {
      provider: 'pg',
      // Le schema Postgres `auth` est porte par les objets de table eux-memes
      // (`pgSchema('auth')`) : l'option `schemaName` de l'adaptateur ne sert
      // qu'a sa CLI de generation, elle n'a aucun effet a l'execution.
      schema: {
        user: auth_user,
        session: auth_session,
        account: auth_account,
        verification: auth_verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Aucune inscription ouverte : les comptes avocats sont crees a
      // l'amorcage. Ce drapeau ferme aussi la voie programmatique
      // `auth.api.signUpEmail` — verifie dans le handler de la version
      // installee, pas suppose d'apres la documentation.
      disableSignUp: true,
      minPasswordLength: LAWYER_PASSWORD_LENGTH_BOUNDS.min,
      maxPasswordLength: LAWYER_PASSWORD_LENGTH_BOUNDS.max,
      password: {
        hash: (plaintext_password: string): Promise<string> =>
          dependencies.password_hasher.hash_plaintext_password(plaintext_password),
        verify: (input: { hash: string; password: string }): Promise<boolean> =>
          dependencies.password_hasher.verify_plaintext_password({
            password_hash: input.hash,
            plaintext_password: input.password,
          }),
      },
    },
    session: {
      expiresIn: LAWYER_AUTH_SESSION_EXPIRY_SECONDS,
      // Une session ne se prolonge pas parce qu'on continue de s'en servir :
      // c'est ce qui fait la difference entre une expiration absolue et une
      // expiration d'inactivite, et une session volee reste alors bornee dans
      // le temps quoi que fasse l'attaquant.
      disableSessionRefresh: true,
    },
    logger: build_lawyer_auth_logger(dependencies.logger),
    advanced: {
      // En developpement l'application tourne en http : exiger un cookie
      // `Secure` y rendrait la connexion impossible.
      useSecureCookies: dependencies.node_environment === 'production',
    },
  });
}

export type LawyerAuth = ReturnType<typeof build_lawyer_auth>;
