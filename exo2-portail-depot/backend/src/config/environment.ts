import { NotImplementedError } from '../domain/not_implemented';
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

// `unknown` plutot que `any` a la frontiere : on recoit des chaines non fiables
// depuis l'environnement, et on ne les tient pour valides qu'apres controle.
export function parse_application_environment(
  _raw_environment: Readonly<Record<string, string | undefined>>,
): ApplicationEnvironment {
  throw new NotImplementedError('parse_application_environment');
}
