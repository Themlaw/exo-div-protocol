import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { DepositRequestsController } from './deposit_requests.controller';
import { DepositRequestLinksController } from './deposit_request_links.controller';
import { AccessLinkModule } from '../access_link/access_link.module';
import { DepositedFileModule } from '../deposited_file/deposited_file.module';
import {
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
} from '../deposited_file/deposited_file_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  DrizzleDepositRequestRepository,
  type DepositRequestRepository,
} from './deposit_request_repository';

@Module({
  imports: [AccessLinkModule, DepositedFileModule],
  controllers: [DepositRequestsController, DepositRequestLinksController],
  providers: [
    {
      provide: DEPOSIT_REQUEST_REPOSITORY,
      inject: [APPLICATION_DATABASE, DEPOSITED_FILE_REPOSITORY],
      useFactory: (
        database: ApplicationDatabase,
        deposited_files: DepositedFileRepository,
      ): DepositRequestRepository =>
        new DrizzleDepositRequestRepository(database, deposited_files),
    },
  ],
  exports: [DEPOSIT_REQUEST_REPOSITORY],
})
export class DepositModule {}
