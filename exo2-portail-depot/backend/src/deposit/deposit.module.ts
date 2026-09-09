import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { DepositRequestsController } from './deposit_requests.controller';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  DrizzleDepositRequestRepository,
  type DepositRequestRepository,
} from './deposit_request_repository';

@Module({
  controllers: [DepositRequestsController],
  providers: [
    {
      provide: DEPOSIT_REQUEST_REPOSITORY,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): DepositRequestRepository =>
        new DrizzleDepositRequestRepository(database),
    },
  ],
})
export class DepositModule {}
