import type { INestApplication } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module';
import { collect_route_access_inventory } from '../../src/auth/route_access_inventory';
import type { RouteAccessDeclaration } from '../../src/auth/route_access';
import { CLOCK, SystemClock, type Clock } from '../../src/shared/clock';
import { APPLICATION_ENVIRONMENT } from '../../src/config/configuration.module';
import {
  parse_application_environment,
  type ApplicationEnvironment,
} from '../../src/config/environment';
import { APPLICATION_LOGGER } from '../../src/shared/logging/logging.module';
import { APPLICATION_DATABASE } from '../../src/db/database.module';
import type { ApplicationDatabase } from '../../src/db/database_connection';
import { auth_account, auth_user } from '../../src/db/schema/auth_schema';
import {
  authentication_failure_by_ip,
  lawyer_login_failure_by_account,
  lawyer_login_failure_by_account_and_ip,
} from '../../src/db/schema/security_schema';
import { deposit_request } from '../../src/db/schema/deposit_schema';
import {
  LAWYER_ACCOUNT_REPOSITORY,
  LAWYER_LOGIN_THROTTLER,
} from '../../src/auth/lawyer_auth.module';
import type { LawyerAccountRepository } from '../../src/auth/lawyer_account_bootstrap';
import { LAWYER_AUTH, type LawyerAuth } from '../../src/auth/lawyer_auth';
import { mount_lawyer_auth_handler } from '../../src/auth/mount_lawyer_auth';
import type { LawyerLoginThrottler } from '../../src/auth/throttle_lawyer_login';
import {
  Argon2idLawyerPasswordHasher,
  LAWYER_PASSWORD_HASHER,
  type LawyerPasswordHasher,
  type LawyerPasswordVerificationInput,
} from '../../src/auth/lawyer_password_hasher';
import { apply_http_hardening } from '../../src/shared/http_hardening';
import { apply_api_route_prefix } from '../../src/shared/api_route_prefix';
import type { ApplicationLogger } from '../../src/shared/logging/application_logger';

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
    plaintext_password: string;
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

export function build_mutable_test_clock(initial_now: Date): MutableTestClock {
  // Copiee, jamais gardee par reference : une `Date` est mutable, et un test
  // qui modifierait la sienne apres coup deplacerait l'horloge de
  // l'application sans le dire.
  let current_now: Date = new Date(initial_now.getTime());

  return {
    now: (): Date => new Date(current_now.getTime()),
    advance_seconds: (seconds: number): void => {
      current_now = new Date(current_now.getTime() + seconds * 1000);
    },
    set: (now: Date): void => {
      current_now = new Date(now.getTime());
    },
  };
}

export interface IntegrationTestApplicationOptions {
  clock?: Clock;
  // Deux deploiements reels, deux comportements opposes, et les tests couvrent
  // les deux. `0` est notre production : le 443 est en passthrough SNI, donc
  // aucun proxy n'ajoute de X-Forwarded-For et l'en-tete recu ne peut venir que
  // du client — on l'ignore. `1` decrit l'installation derriere notre Traefik,
  // ou la derniere entree de la chaine est ecrite par un relais de confiance.
  // Le defaut est le mode degrade : c'est celui ou la limitation doit tenir
  // toute seule.
  trusted_proxy_hop_count?: number;
  // Permet d'affirmer qu'un secret n'est PAS journalise. Sans capture, un test
  // ne peut que constater que l'application n'a pas plante.
  logger?: ApplicationLogger;
}

// Muet par defaut : les tests d'integration en emettraient des centaines, et
// c'est le fournisseur de production qui ecrit sur la sortie standard.
function app_logger_of_last_resort(): ApplicationLogger {
  const ignore = (): void => undefined;
  return { debug: ignore, info: ignore, warn: ignore, error: ignore };
}

// Compte les appels reels au hachage. La verification en fait partie : c'est
// elle qui coute, et c'est elle qu'un attaquant cherche a se faire offrir.
class CountingLawyerPasswordHasher implements LawyerPasswordHasher {
  private call_count = 0;

  constructor(private readonly delegate: LawyerPasswordHasher) {}

  read_call_count(): number {
    return this.call_count;
  }

  async hash_plaintext_password(plaintext_password: string): Promise<string> {
    this.call_count += 1;
    return this.delegate.hash_plaintext_password(plaintext_password);
  }

  async verify_plaintext_password(
    input: LawyerPasswordVerificationInput,
  ): Promise<boolean> {
    this.call_count += 1;
    return this.delegate.verify_plaintext_password(input);
  }
}

// La base est partagee par tous les fichiers de test et survit d'une execution
// a l'autre. Sans cette remise a zero, un bloc qui a volontairement franchi le
// plafond par adresse ferait echouer le bloc suivant, et l'echec designerait le
// mauvais coupable ; les demandes, elles, s'accumuleraient jusqu'a rendre toute
// assertion sur une liste impossible a ecrire.
//
// Le compte de demonstration, lui, est conserve : c'est l'amorcage de
// production qui le pose, et le detruire testerait une application qui n'existe
// pas. Les documents attendus partent par la cascade de leur demande.
async function reset_state_shared_between_tests(database: ApplicationDatabase): Promise<void> {
  await database.delete(authentication_failure_by_ip);
  await database.delete(lawyer_login_failure_by_account);
  await database.delete(lawyer_login_failure_by_account_and_ip);
  await database.delete(deposit_request);
  // Les liens et les sessions partent par la cascade de leur demande.
}

export async function create_integration_test_application(
  options?: IntegrationTestApplicationOptions,
): Promise<IntegrationTestApplication> {
  const counting_password_hasher = new CountingLawyerPasswordHasher(
    new Argon2idLawyerPasswordHasher(),
  );

  const module: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LAWYER_PASSWORD_HASHER)
    .useValue(counting_password_hasher)
    .overrideProvider(CLOCK)
    .useValue(options?.clock ?? new SystemClock())
    .overrideProvider(APPLICATION_LOGGER)
    .useValue(options?.logger ?? app_logger_of_last_resort())
    .overrideProvider(APPLICATION_ENVIRONMENT)
    .useValue({
      ...parse_application_environment(process.env),
      trusted_proxy_hop_count: options?.trusted_proxy_hop_count ?? 0,
    } satisfies ApplicationEnvironment)
    .compile();

  const app: INestApplication = module.createNestApplication({ logger: false });

  // Meme ordre que dans main.ts, et pour les memes raisons : le durcissement
  // avant tout, le montage de BetterAuth avant `init()` faute de quoi le
  // routeur Nest repondrait 404 sur des chemins qu'aucun controleur ne declare.
  // Un harnais qui monterait autrement testerait une application qui n'existe pas.
  apply_http_hardening(
    app.getHttpAdapter().getInstance(),
    app.get<ApplicationEnvironment>(APPLICATION_ENVIRONMENT).node_environment,
  );
  apply_api_route_prefix(app);
  mount_lawyer_auth_handler(app, {
    lawyer_auth: app.get<LawyerAuth>(LAWYER_AUTH),
    throttle_lawyer_login: app.get<LawyerLoginThrottler>(LAWYER_LOGIN_THROTTLER),
    logger: app.get<ApplicationLogger>(APPLICATION_LOGGER),
  });

  await app.init();

  const database: ApplicationDatabase = app.get(APPLICATION_DATABASE);
  await reset_state_shared_between_tests(database);

  return {
    app,
    password_hashing_call_count: (): number => counting_password_hasher.read_call_count(),
    read_stored_password_hash: async (email: string): Promise<string | null> => {
      const rows = await database
        .select({ password_hash: auth_account.password })
        .from(auth_account)
        .innerJoin(auth_user, eq(auth_account.userId, auth_user.id))
        .where(
          and(
            eq(sql`lower(${auth_user.email})`, email.trim().toLowerCase()),
            eq(auth_account.providerId, 'credential'),
          ),
        );

      return rows[0]?.password_hash ?? null;
    },
    create_lawyer_account: async (input: {
      email: string;
      plaintext_password: string;
    }): Promise<string> =>
      app.get<LawyerAccountRepository>(LAWYER_ACCOUNT_REPOSITORY).create(input),
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

// Permet au test structurel de verifier les routes qu'on n'a PAS encore ecrites :
// c'est lui qui fera echouer la CI le jour ou quelqu'un ajoutera une route sans
// se demander qui a le droit de l'appeler.
export function collect_route_access_declarations(
  app: INestApplication,
): readonly RouteAccessDeclaration[] {
  return collect_route_access_inventory(app.get(DiscoveryService, { strict: false }));
}

export type { RouteAccessDeclaration };
