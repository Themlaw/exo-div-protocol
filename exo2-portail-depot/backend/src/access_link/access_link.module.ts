import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import {
  ARGON2_CONCURRENCY_GATE,
  type Argon2ConcurrencyGate,
} from '../shared/argon2_concurrency_gate';
import type { PinHasher } from '../domain/verify_client_pin';
import {
  ACCESS_LINK_REPOSITORY,
  DrizzleAccessLinkRepository,
  type AccessLinkRepository,
} from './access_link_repository';
import {
  AccessLinkTokenHmacHasher,
  ACCESS_LINK_TOKEN_HASHER,
  type AccessLinkTokenHasher,
} from './access_link_token_hasher';
import {
  Argon2idClientPinHasher,
  CLIENT_PIN_HASHER,
  ConcurrencyBoundedPinHasher,
} from './client_pin_hasher';
import {
  ACCESS_LINK_ISSUER,
  AccessLinkIssuanceService,
  RANDOM_SOURCE,
  SYSTEM_RANDOM_SOURCE,
  type AccessLinkIssuer,
} from './access_link_issuer';
import { CLOCK, type Clock } from '../shared/clock';
import type { RandomSource } from '../domain/presigned_upload';

@Module({
  providers: [
    {
      provide: ACCESS_LINK_REPOSITORY,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): AccessLinkRepository =>
        new DrizzleAccessLinkRepository(database),
    },
    {
      provide: ACCESS_LINK_TOKEN_HASHER,
      inject: [APPLICATION_ENVIRONMENT],
      useFactory: (environment: ApplicationEnvironment): AccessLinkTokenHasher =>
        new AccessLinkTokenHmacHasher(environment.access_link_token_pepper),
    },
    {
      // Le hasher expose a l'application est TOUJOURS celui qui porte le
      // portillon : fournir le hasher nu a cote laisserait un futur appelant
      // choisir, par inadvertance, celui qui ne plafonne rien.
      provide: CLIENT_PIN_HASHER,
      inject: [ARGON2_CONCURRENCY_GATE],
      useFactory: (concurrency_gate: Argon2ConcurrencyGate): PinHasher =>
        new ConcurrencyBoundedPinHasher(new Argon2idClientPinHasher(), concurrency_gate),
    },
    { provide: RANDOM_SOURCE, useValue: SYSTEM_RANDOM_SOURCE },
    {
      provide: ACCESS_LINK_ISSUER,
      inject: [
        ACCESS_LINK_REPOSITORY,
        ACCESS_LINK_TOKEN_HASHER,
        CLIENT_PIN_HASHER,
        CLOCK,
        RANDOM_SOURCE,
        APPLICATION_ENVIRONMENT,
      ],
      useFactory: (
        access_links: AccessLinkRepository,
        token_hasher: AccessLinkTokenHasher,
        pin_hasher: PinHasher,
        clock: Clock,
        random_source: RandomSource,
        environment: ApplicationEnvironment,
      ): AccessLinkIssuer =>
        new AccessLinkIssuanceService({
          access_links,
          token_hasher,
          pin_hasher,
          clock,
          random_source,
          public_base_url: environment.public_base_url,
        }),
    },
  ],
  exports: [
    ACCESS_LINK_REPOSITORY,
    ACCESS_LINK_TOKEN_HASHER,
    CLIENT_PIN_HASHER,
    ACCESS_LINK_ISSUER,
  ],
})
export class AccessLinkModule {}
