import { Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
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
  ],
  exports: [DEPOSITED_FILE_REPOSITORY],
})
export class DepositedFileModule {}
