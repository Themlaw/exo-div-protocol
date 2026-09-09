import { Global, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { APPLICATION_LOGGER } from '../shared/logging/logging.module';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import {
  bootstrap_demo_lawyer_account,
  type LawyerAccountBootstrapOutcome,
  type LawyerAccountRepository,
} from './lawyer_account_bootstrap';
import { BetterAuthLawyerSessionReader } from './better_auth_lawyer_session_reader';
import { DrizzleLawyerAccountRepository } from './drizzle_lawyer_account_repository';
import { build_lawyer_auth, LAWYER_AUTH, type LawyerAuth } from './lawyer_auth';
import {
  Argon2idLawyerPasswordHasher,
  LAWYER_PASSWORD_HASHER,
  type LawyerPasswordHasher,
} from './lawyer_password_hasher';
import { LAWYER_SESSION_READER, type LawyerSessionReader } from './lawyer_session_reader';
import { LAWYER_AUTH_LOG_CONTEXT } from './lawyer_auth_logging';
import { CLOCK, type Clock } from '../shared/clock';
import {
  DrizzleLoginThrottleStore,
  LOGIN_THROTTLE_STORE,
  type LoginThrottleStore,
} from './login_throttle_store';
import {
  build_lawyer_login_throttler,
  type LawyerLoginThrottler,
} from './throttle_lawyer_login';
import { MAXIMUM_LAWYER_AUTH_REQUEST_BODY_BYTES } from './mount_lawyer_auth';
import {
  build_login_concurrency_gate,
  type LoginConcurrencyGate,
} from './login_concurrency_gate';

export const LAWYER_ACCOUNT_REPOSITORY: unique symbol = Symbol('LAWYER_ACCOUNT_REPOSITORY');
export const LAWYER_LOGIN_THROTTLER: unique symbol = Symbol('LAWYER_LOGIN_THROTTLER');
export const LOGIN_CONCURRENCY_GATE: unique symbol = Symbol('LOGIN_CONCURRENCY_GATE');

// L'amorcage tourne au demarrage de l'application, pas dans un script separe :
// apres install.sh, personne n'a de terminal a ouvrir, et un compte cree par
// une commande qu'on oublie de lancer est une installation qui ne sert a rien.
// Idempotent par construction : relancer ne duplique pas et n'echoue pas.
@Injectable()
export class DemoLawyerAccountBootstrapper implements OnModuleInit {
  constructor(
    @Inject(APPLICATION_ENVIRONMENT) private readonly environment: ApplicationEnvironment,
    @Inject(LAWYER_ACCOUNT_REPOSITORY)
    private readonly lawyer_accounts: LawyerAccountRepository,
    @Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    const outcome: LawyerAccountBootstrapOutcome = await bootstrap_demo_lawyer_account(
      {
        email: this.environment.demo_lawyer_email,
        plaintext_password: this.environment.demo_lawyer_password,
      },
      { lawyer_accounts: this.lawyer_accounts },
    );

    // L'email seul, jamais le mot de passe : ce journal est lu par plus de
    // monde que la base.
    this.logger.info(
      LAWYER_AUTH_LOG_CONTEXT,
      outcome.account_was_created
        ? 'compte avocat de demonstration cree'
        : 'compte avocat de demonstration deja present',
      { demo_lawyer_email: this.environment.demo_lawyer_email },
    );
  }
}

@Global()
@Module({
  providers: [
    {
      provide: LAWYER_PASSWORD_HASHER,
      useFactory: (): LawyerPasswordHasher => new Argon2idLawyerPasswordHasher(),
    },
    {
      provide: LAWYER_AUTH,
      inject: [
        APPLICATION_DATABASE,
        LAWYER_PASSWORD_HASHER,
        APPLICATION_ENVIRONMENT,
        APPLICATION_LOGGER,
      ],
      useFactory: (
        database: ApplicationDatabase,
        password_hasher: LawyerPasswordHasher,
        environment: ApplicationEnvironment,
        logger: ApplicationLogger,
      ): LawyerAuth =>
        build_lawyer_auth({
          database,
          password_hasher,
          public_base_url: environment.public_base_url,
          logger,
          lawyer_auth_secret: environment.lawyer_auth_secret,
        }),
    },
    {
      provide: LAWYER_SESSION_READER,
      inject: [LAWYER_AUTH, CLOCK],
      useFactory: (lawyer_auth: LawyerAuth, clock: Clock): LawyerSessionReader =>
        new BetterAuthLawyerSessionReader(lawyer_auth, clock),
    },
    {
      provide: LAWYER_ACCOUNT_REPOSITORY,
      inject: [APPLICATION_DATABASE, LAWYER_PASSWORD_HASHER],
      useFactory: (
        database: ApplicationDatabase,
        password_hasher: LawyerPasswordHasher,
      ): LawyerAccountRepository =>
        new DrizzleLawyerAccountRepository(database, password_hasher),
    },
    {
      provide: LOGIN_THROTTLE_STORE,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): LoginThrottleStore =>
        new DrizzleLoginThrottleStore(database),
    },
    {
      // Un seul portillon pour tout le processus : un par requete ne
      // plafonnerait rien du tout.
      provide: LOGIN_CONCURRENCY_GATE,
      useFactory: (): LoginConcurrencyGate => build_login_concurrency_gate(),
    },
    {
      provide: LAWYER_LOGIN_THROTTLER,
      inject: [
        LOGIN_THROTTLE_STORE,
        CLOCK,
        LOGIN_CONCURRENCY_GATE,
        APPLICATION_ENVIRONMENT,
        APPLICATION_LOGGER,
      ],
      useFactory: (
        throttle_store: LoginThrottleStore,
        clock: Clock,
        concurrency_gate: LoginConcurrencyGate,
        environment: ApplicationEnvironment,
        logger: ApplicationLogger,
      ): LawyerLoginThrottler =>
        build_lawyer_login_throttler({
          throttle_store,
          clock,
          concurrency_gate,
          trusted_proxy_hop_count: environment.trusted_proxy_hop_count,
          logger,
          maximum_request_body_bytes: MAXIMUM_LAWYER_AUTH_REQUEST_BODY_BYTES,
        }),
    },
    DemoLawyerAccountBootstrapper,
  ],
  exports: [
    LAWYER_AUTH,
    LAWYER_SESSION_READER,
    LAWYER_PASSWORD_HASHER,
    LAWYER_ACCOUNT_REPOSITORY,
    LOGIN_THROTTLE_STORE,
    LAWYER_LOGIN_THROTTLER,
    LOGIN_CONCURRENCY_GATE,
  ],
})
export class LawyerAuthModule {}
