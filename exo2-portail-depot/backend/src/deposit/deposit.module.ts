import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { DepositRequestsController } from './deposit_requests.controller';
import { DepositRequestLinksController } from './deposit_request_links.controller';
import { AccessLinkModule } from '../access_link/access_link.module';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  DrizzleDepositRequestRepository,
  type DepositRequestRepository,
} from './deposit_request_repository';

@Module({
  imports: [AccessLinkModule],
  controllers: [DepositRequestsController, DepositRequestLinksController],
  providers: [
    {
      provide: DEPOSIT_REQUEST_REPOSITORY,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): DepositRequestRepository =>
        new DrizzleDepositRequestRepository(database),
    },
  ],
  exports: [DEPOSIT_REQUEST_REPOSITORY],
})
export class DepositModule {}
