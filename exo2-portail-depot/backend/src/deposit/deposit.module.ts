import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { DepositRequestsController } from './deposit_requests.controller';
import { DepositRequestLinksController } from './deposit_request_links.controller';
import { DepositRequestActivityController } from './deposit_request_activity.controller';
import { DepositRequestFilesController } from './deposit_request_files.controller';
import { AccessLinkModule } from '../access_link/access_link.module';
import { DepositedFileModule } from '../deposited_file/deposited_file.module';
import {
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
} from '../deposited_file/deposited_file_repository';
import {
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  DrizzleDepositRequestRepository,
  type DepositRequestRepository,
} from './deposit_request_repository';

@Module({
  imports: [AccessLinkModule, DepositedFileModule],
  controllers: [
    DepositRequestsController,
    DepositRequestLinksController,
    DepositRequestActivityController,
    DepositRequestFilesController,
  ],
  providers: [
    {
      provide: DEPOSIT_REQUEST_REPOSITORY,
      inject: [APPLICATION_DATABASE, DEPOSITED_FILE_REPOSITORY, ACTIVITY_EVENT_REPOSITORY],
      useFactory: (
        database: ApplicationDatabase,
        deposited_files: DepositedFileRepository,
        activity_events: ActivityEventRepository,
      ): DepositRequestRepository =>
        new DrizzleDepositRequestRepository(database, deposited_files, activity_events),
    },
  ],
  exports: [DEPOSIT_REQUEST_REPOSITORY],
})
export class DepositModule {}
