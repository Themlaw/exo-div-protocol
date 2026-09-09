import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { OBJECT_STORAGE, type ObjectStorage } from '../object_storage/object_storage';
import {
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import { CLOCK, type Clock } from '../shared/clock';
import {
  LAWYER_DOWNLOAD_AUTHORIZER,
  LawyerDownloadAuthorizationService,
  type LawyerDownloadAuthorizer,
} from './authorize_lawyer_download';
import {
  DEPOSITED_FILE_REPOSITORY,
  DrizzleDepositedFileRepository,
  type DepositedFileRepository,
} from './deposited_file_repository';

@Module({
  providers: [
    {
      provide: DEPOSITED_FILE_REPOSITORY,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): DepositedFileRepository =>
        new DrizzleDepositedFileRepository(database),
    },
    {
      provide: LAWYER_DOWNLOAD_AUTHORIZER,
      inject: [DEPOSITED_FILE_REPOSITORY, OBJECT_STORAGE, ACTIVITY_EVENT_REPOSITORY, CLOCK],
      useFactory: (
        deposited_files: DepositedFileRepository,
        object_storage: ObjectStorage,
        activity_events: ActivityEventRepository,
        clock: Clock,
      ): LawyerDownloadAuthorizer =>
        new LawyerDownloadAuthorizationService({
          deposited_files,
          object_storage,
          activity_events,
          clock,
        }),
    },
  ],
  exports: [DEPOSITED_FILE_REPOSITORY, LAWYER_DOWNLOAD_AUTHORIZER],
})
export class DepositedFileModule {}
