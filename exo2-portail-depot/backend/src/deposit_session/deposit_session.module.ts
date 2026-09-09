import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { AccessLinkModule } from '../access_link/access_link.module';
import { DepositModule } from '../deposit/deposit.module';
import {
  ACCESS_LINK_REPOSITORY,
  type AccessLinkRepository,
} from '../access_link/access_link_repository';
import {
  ACCESS_LINK_TOKEN_HASHER,
  type AccessLinkTokenHasher,
} from '../access_link/access_link_token_hasher';
import { CLIENT_PIN_HASHER } from '../access_link/client_pin_hasher';
import { RANDOM_SOURCE } from '../access_link/access_link_issuer';
import type { PinHasher } from '../domain/verify_client_pin';
import type { RandomSource } from '../domain/presigned_upload';
import { CLOCK, type Clock } from '../shared/clock';
import {
  DEPOSIT_SESSION_REPOSITORY,
  DrizzleDepositSessionRepository,
  type DepositSessionRepository,
} from './deposit_session_repository';
import {
  CLIENT_PIN_THROTTLE_STORE,
  DrizzleClientPinThrottleStore,
  type ClientPinThrottleStore,
} from './client_pin_throttle_store';
import {
  DEPOSIT_LINK_UNLOCKER,
  DepositLinkUnlockService,
  type DepositLinkUnlocker,
} from './unlock_deposit_link';
import { PublicDepositLinkController } from './public_deposit_link.controller';

@Module({
  imports: [AccessLinkModule, DepositModule],
  controllers: [PublicDepositLinkController],
  providers: [
    {
      provide: DEPOSIT_SESSION_REPOSITORY,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): DepositSessionRepository =>
        new DrizzleDepositSessionRepository(database),
    },
    {
      provide: CLIENT_PIN_THROTTLE_STORE,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): ClientPinThrottleStore =>
        new DrizzleClientPinThrottleStore(database),
    },
    {
      provide: DEPOSIT_LINK_UNLOCKER,
      inject: [
        ACCESS_LINK_REPOSITORY,
        DEPOSIT_SESSION_REPOSITORY,
        ACCESS_LINK_TOKEN_HASHER,
        CLIENT_PIN_HASHER,
        CLIENT_PIN_THROTTLE_STORE,
        CLOCK,
        RANDOM_SOURCE,
      ],
      useFactory: (
        access_links: AccessLinkRepository,
        deposit_sessions: DepositSessionRepository,
        token_hasher: AccessLinkTokenHasher,
        pin_hasher: PinHasher,
        throttle_store: ClientPinThrottleStore,
        clock: Clock,
        random_source: RandomSource,
      ): DepositLinkUnlocker =>
        new DepositLinkUnlockService({
          access_links,
          deposit_sessions,
          token_hasher,
          pin_hasher,
          throttle_store,
          clock,
          random_source,
        }),
    },
  ],
  exports: [DEPOSIT_SESSION_REPOSITORY, CLIENT_PIN_THROTTLE_STORE, DEPOSIT_LINK_UNLOCKER],
})
export class DepositSessionModule {}
