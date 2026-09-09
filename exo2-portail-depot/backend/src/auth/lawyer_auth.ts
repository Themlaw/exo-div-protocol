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

export const LAWYER_AUTH_ERROR_LOG_CONTEXT = 'lawyer_auth';

// Expiration ABSOLUE de huit heures : la duree d'une journee de travail. Un
// poste laisse ouvert au cabinet le soir ne rouvre pas les pieces le lendemain.
export const LAWYER_AUTH_SESSION_EXPIRY_SECONDS = 8 * 60 * 60;

export interface LawyerAuthDependencies {
  database: ApplicationDatabase;
  password_hasher: LawyerPasswordHasher;
  public_base_url: string;
  node_environment: NodeEnvironment;
  logger: ApplicationLogger;
  lawyer_auth_secret: string;
}

// Sans annotation de retour, contrairement au reste du depot : `betterAuth`
// rend un type parametre par l'objet d'options LITTERAL qui lui est passe, et
// l'annoter avec la forme large `Auth<BetterAuthOptions>` ne compile pas. Le
// type exact est donc publie juste apres, deduit de cette fonction.
export function build_lawyer_auth(dependencies: LawyerAuthDependencies) {
  return betterAuth({
    // Fourni explicitement : sans lui la bibliotheque retombe sur une constante
    // publiee sur npm, et ne s'en plaint qu'a la PREMIERE REQUETE. Le demarrage
    // serait vert et le portail repondrait 500.
    secret: dependencies.lawyer_auth_secret,
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
    // Le limiteur de la bibliotheque est DESACTIVE, et ce n'est pas un
    // relachement : c'est qu'il ne peut pas faire autre chose que du mal ici.
    //
    // Sa cle est l'adresse du client, qu'il derive lui-meme d'un
    // `X-Forwarded-For` a une seule entree — donc forgeable a volonte par
    // l'attaquant, qui echappe alors a tout plafond. Et quand aucun en-tete
    // n'est present, ce qui est notre mode degrade (passthrough SNI), il
    // retombe sur UN SEUL SEAU partage par le monde entier. Dans les deux cas,
    // le seul a etre reellement refuse est l'avocat legitime.
    //
    // Relever ses bornes n'y change rien : avec un seau partage, tout plafond
    // fini est un levier de deni de service, et un plafond haut sur une longue
    // fenetre allonge la coupure au lieu de la supprimer. Mesure : 3 requetes
    // fermaient la connexion 10 secondes, 100 par 900 secondes la fermeraient
    // un quart d'heure, pour un cout d'attaque comparable.
    //
    // La limitation qui vaut pour ce produit est celle de `login_throttling.ts`
    // — trois couches, dont la seule qui puisse atteindre l'avocat legitime n'a
    // pas le droit de refuser — adossee a `resolve_trusted_client_ip`, qui
    // n'accorde de confiance qu'a un nombre DECLARE de relais.
    rateLimit: { enabled: false },
    logger: build_lawyer_auth_logger(dependencies.logger),
    // Sans gestionnaire, better-call ecrit l'erreur avec un `console.error`
    // brut : hors du logger, hors du masquage des secrets, hors du format JSON.
    onAPIError: {
      onError: (error: unknown): void => {
        dependencies.logger.error(
          LAWYER_AUTH_ERROR_LOG_CONTEXT,
          "erreur remontee par la surface d'authentification",
          { error },
        );
      },
    },
    advanced: {
      // En developpement l'application tourne en http : exiger un cookie
      // `Secure` y rendrait la connexion impossible.
      useSecureCookies: dependencies.node_environment === 'production',
    },
  });
}

export type LawyerAuth = ReturnType<typeof build_lawyer_auth>;
