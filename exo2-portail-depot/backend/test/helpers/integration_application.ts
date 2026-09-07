import type { INestApplication } from '@nestjs/common';
import { NotImplementedError } from '../../src/domain/not_implemented';
import type { RouteAccessKind } from '../../src/auth/route_access';
import type { Clock } from '../../src/shared/clock';

export interface IntegrationTestApplication {
  app: INestApplication;

  // --- Instrumentation reservee au harnais de test ---
  // Certaines proprietes de securite ne s'observent pas en HTTP, et c'est
  // precisement ce qui fait leur valeur : si l'exterieur pouvait les distinguer,
  // ce serait deja la faille. Le harnais enveloppe donc les vraies dependances
  // dans le module de test — l'application de production, elle, n'expose rien
  // de tout ceci.

  // Compte les appels reels au hachage. C'est ce qui permet de prouver qu'un
  // compte inexistant coute exactement le meme travail qu'un mot de passe faux,
  // sans jamais chronometrer quoi que ce soit.
  password_hashing_call_count(): number;

  // Le hash stocke n'est expose par aucune route, et ne doit pas l'etre. Le
  // lire ici est le seul moyen de verifier qu'il est sale par compte.
  read_stored_password_hash(email: string): Promise<string | null>;

  // Les comptes avocats sont crees par seed, sans route d'inscription : un test
  // qui a besoin d'un second compte n'a aucun moyen HTTP de l'obtenir.
  create_lawyer_account(input: {
    email: string;
    password: string;
  }): Promise<string>;

  close(): Promise<void>;
}

// Tolere `undefined` : quand `beforeAll` a echoue, l'application n'existe pas,
// et un `close()` direct ajouterait un TypeError qui masque la vraie cause.
export async function close_integration_test_application(
  application: IntegrationTestApplication | undefined,
): Promise<void> {
  await application?.close();
}

// Horloge pilotable, plutot que `jest.useFakeTimers()` : les faux timers ne
// couvrent que ce qui lit l'horloge du processus, et rateraient un compteur
// adosse a un TTL externe. Faire avancer l'horloge que l'application utilise
// reellement teste le comportement, pas une hypothese sur l'implementation.
export interface MutableTestClock extends Clock {
  advance_seconds(seconds: number): void;
  set(now: Date): void;
}

export function build_mutable_test_clock(_initial_now: Date): MutableTestClock {
  throw new NotImplementedError('build_mutable_test_clock');
}

export interface IntegrationTestApplicationOptions {
  clock?: Clock;
}

export function create_integration_test_application(
  _options?: IntegrationTestApplicationOptions,
): Promise<IntegrationTestApplication> {
  throw new NotImplementedError('create_integration_test_application');
}

export interface RouteAccessDeclaration {
  http_method: string;
  path: string;
  access_kind: RouteAccessKind;
}

// Permet au test structurel de verifier les routes qu'on n'a PAS encore ecrites :
// c'est lui qui fera echouer la CI le jour ou quelqu'un ajoutera une route sans
// se demander qui a le droit de l'appeler.
export function collect_route_access_declarations(
  _app: INestApplication,
): readonly RouteAccessDeclaration[] {
  throw new NotImplementedError('collect_route_access_declarations');
}
