import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { AccessLinkModule } from '../access_link/access_link.module';
import { DepositModule } from '../deposit/deposit.module';
import { DepositedFileModule } from '../deposited_file/deposited_file.module';
import {
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
} from '../deposited_file/deposited_file_repository';
import {
  CLIENT_FILE_REMOVER,
  ClientFileRemovalService,
  type ClientFileRemover,
} from '../deposited_file/remove_client_file';
import {
  CLIENT_UPLOAD_AUTHORIZER,
  ClientUploadAuthorizationService,
  type ClientUploadAuthorizer,
} from '../deposited_file/authorize_client_upload';
import { OBJECT_STORAGE, type ObjectStorage } from '../object_storage/object_storage';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestRepository,
} from '../deposit/deposit_request_repository';
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
import {
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import { APPLICATION_LOGGER } from '../shared/logging/logging.module';
import type { ApplicationLogger } from '../shared/logging/application_logger';
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
  imports: [AccessLinkModule, DepositModule, DepositedFileModule],
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
        ACTIVITY_EVENT_REPOSITORY,
        DEPOSIT_SESSION_REPOSITORY,
        ACCESS_LINK_TOKEN_HASHER,
        CLIENT_PIN_HASHER,
        CLIENT_PIN_THROTTLE_STORE,
        CLOCK,
        RANDOM_SOURCE,
        APPLICATION_LOGGER,
      ],
      useFactory: (
        access_links: AccessLinkRepository,
        activity_events: ActivityEventRepository,
        deposit_sessions: DepositSessionRepository,
        token_hasher: AccessLinkTokenHasher,
        pin_hasher: PinHasher,
        throttle_store: ClientPinThrottleStore,
        clock: Clock,
        random_source: RandomSource,
        logger: ApplicationLogger,
      ): DepositLinkUnlocker =>
        new DepositLinkUnlockService({
          access_links,
          activity_events,
          deposit_sessions,
          token_hasher,
          pin_hasher,
          throttle_store,
          clock,
          random_source,
          logger,
        }),
    },
    {
      provide: CLIENT_UPLOAD_AUTHORIZER,
      inject: [
        DEPOSIT_REQUEST_REPOSITORY,
        DEPOSITED_FILE_REPOSITORY,
        DEPOSIT_SESSION_REPOSITORY,
        OBJECT_STORAGE,
        CLOCK,
      ],
      useFactory: (
        deposit_requests: DepositRequestRepository,
        deposited_files: DepositedFileRepository,
        deposit_sessions: DepositSessionRepository,
        object_storage: ObjectStorage,
        clock: Clock,
      ): ClientUploadAuthorizer =>
        new ClientUploadAuthorizationService({
          deposit_requests,
          deposited_files,
          deposit_sessions,
          object_storage,
          clock,
        }),
    },
    {
      provide: CLIENT_FILE_REMOVER,
      inject: [
        DEPOSIT_REQUEST_REPOSITORY,
        DEPOSITED_FILE_REPOSITORY,
        OBJECT_STORAGE,
        ACTIVITY_EVENT_REPOSITORY,
        CLOCK,
      ],
      useFactory: (
        deposit_requests: DepositRequestRepository,
        deposited_files: DepositedFileRepository,
        object_storage: ObjectStorage,
        activity_events: ActivityEventRepository,
        clock: Clock,
      ): ClientFileRemover =>
        new ClientFileRemovalService({
          deposit_requests,
          deposited_files,
          object_storage,
          activity_events,
          clock,
        }),
    },
  ],
  exports: [
    DEPOSIT_SESSION_REPOSITORY,
    CLIENT_PIN_THROTTLE_STORE,
    DEPOSIT_LINK_UNLOCKER,
    CLIENT_UPLOAD_AUTHORIZER,
    CLIENT_FILE_REMOVER,
  ],
})
export class DepositSessionModule {}
