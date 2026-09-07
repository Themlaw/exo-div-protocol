import type { NodeEnvironment } from '../auth/lawyer_account_bootstrap';

// Les noms sont fixes ICI, et nulle part ailleurs : `.env.example`, install.sh
// et les tests s'y referent tous. Sans source unique, chacun devine les siens et
// l'application demarre avec une variable que personne ne renseigne.
export const ENVIRONMENT_VARIABLE_NAMES = {
  node_environment: 'NODE_ENV',
  database_url: 'DATABASE_URL',
  access_link_token_pepper: 'ACCESS_LINK_TOKEN_PEPPER',
  internal_storage_webhook_secret: 'INTERNAL_STORAGE_WEBHOOK_SECRET',
  minio_endpoint: 'MINIO_ENDPOINT',
  minio_root_user: 'MINIO_ROOT_USER',
  minio_root_password: 'MINIO_ROOT_PASSWORD',
  demo_lawyer_email: 'DEMO_LAWYER_EMAIL',
  demo_lawyer_password: 'DEMO_LAWYER_PASSWORD',
} as const satisfies Record<keyof ApplicationEnvironment, string>;

export const REQUIRED_ENVIRONMENT_VARIABLES: readonly string[] =
  Object.values(ENVIRONMENT_VARIABLE_NAMES);

export interface ApplicationEnvironment {
  node_environment: NodeEnvironment;
  database_url: string;
  access_link_token_pepper: string;
  // MinIO signe ses notifications d'objet avec ce secret. Sans lui, n'importe qui
  // pourrait declarer l'arrivee d'un fichier sain.
  internal_storage_webhook_secret: string;
  minio_endpoint: string;
  minio_root_user: string;
  minio_root_password: string;
  demo_lawyer_email: string;
  demo_lawyer_password: string;
}

export type EnvironmentViolationReason = 'missing' | 'malformed';

export interface EnvironmentViolation {
  variable: string;
  reason: EnvironmentViolationReason;
}

// L'application refuse de demarrer plutot que de casser a la premiere requete :
// une panne obscure en production devient un message clair au demarrage, et
// install.sh devient diagnosticable.
export class InvalidEnvironmentError extends Error {
  constructor(readonly violations: readonly EnvironmentViolation[]) {
    super(
      `Configuration invalide : ${violations
        .map((violation) => `${violation.variable} (${violation.reason})`)
        .join(', ')}`,
    );
    this.name = 'InvalidEnvironmentError';
  }
}

// Le poivre protege tous les tokens de lien : un poivre court annule l'interet
// du HMAC, et c'est le genre de valeur qu'on tronque par accident.
export const MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH = 32;

export const MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH = 32;

const VALID_NODE_ENVIRONMENTS: readonly NodeEnvironment[] = [
  'development',
  'test',
  'production',
];

function is_valid_node_environment(value: string): value is NodeEnvironment {
  return (VALID_NODE_ENVIRONMENTS as readonly string[]).includes(value);
}

function is_postgres_database_url(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

// `unknown` plutot que `any` a la frontiere : on recoit des chaines non fiables
// depuis l'environnement, et on ne les tient pour valides qu'apres controle.
export function parse_application_environment(
  raw_environment: Readonly<Record<string, string | undefined>>,
): ApplicationEnvironment {
  const violations: EnvironmentViolation[] = [];

  // Une chaine vide compte comme manquante : une variable presente mais vide
  // n'est configuree qu'en apparence.
  function required_value(variable_name: string): string | undefined {
    const raw_value = raw_environment[variable_name];
    if (raw_value === undefined || raw_value === '') {
      violations.push({ variable: variable_name, reason: 'missing' });
      return undefined;
    }
    return raw_value;
  }

  const node_environment_raw = required_value(
    ENVIRONMENT_VARIABLE_NAMES.node_environment,
  );
  const database_url = required_value(ENVIRONMENT_VARIABLE_NAMES.database_url);
  const access_link_token_pepper = required_value(
    ENVIRONMENT_VARIABLE_NAMES.access_link_token_pepper,
  );
  const internal_storage_webhook_secret = required_value(
    ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret,
  );
  const minio_endpoint = required_value(ENVIRONMENT_VARIABLE_NAMES.minio_endpoint);
  const minio_root_user = required_value(ENVIRONMENT_VARIABLE_NAMES.minio_root_user);
  const minio_root_password = required_value(
    ENVIRONMENT_VARIABLE_NAMES.minio_root_password,
  );
  const demo_lawyer_email = required_value(
    ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email,
  );
  const demo_lawyer_password = required_value(
    ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password,
  );

  // On ne verifie la forme d'une variable que si elle est bien presente : une
  // variable manquante n'a pas a produire une seconde violation "malformed".
  let node_environment: NodeEnvironment | undefined;
  if (node_environment_raw !== undefined) {
    if (is_valid_node_environment(node_environment_raw)) {
      node_environment = node_environment_raw;
    } else {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.node_environment,
        reason: 'malformed',
      });
    }
  }

  if (database_url !== undefined && !is_postgres_database_url(database_url)) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.database_url,
      reason: 'malformed',
    });
  }

  if (
    access_link_token_pepper !== undefined &&
    access_link_token_pepper.length < MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH
  ) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.access_link_token_pepper,
      reason: 'malformed',
    });
  }

  if (
    internal_storage_webhook_secret !== undefined &&
    internal_storage_webhook_secret.length <
      MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH
  ) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret,
      reason: 'malformed',
    });
  }

  if (violations.length > 0) {
    throw new InvalidEnvironmentError(violations);
  }

  // A ce point, toute violation possible a deja fait sortir la fonction : les
  // valeurs requises sont necessairement definies.
  return {
    node_environment: node_environment as NodeEnvironment,
    database_url: database_url as string,
    access_link_token_pepper: access_link_token_pepper as string,
    internal_storage_webhook_secret: internal_storage_webhook_secret as string,
    minio_endpoint: minio_endpoint as string,
    minio_root_user: minio_root_user as string,
    minio_root_password: minio_root_password as string,
    demo_lawyer_email: demo_lawyer_email as string,
    demo_lawyer_password: demo_lawyer_password as string,
  };
}
