import { Global, Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { APPLICATION_LOGGER } from '../shared/logging/logging.module';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import { CLOCK, type Clock } from '../shared/clock';
import { DepositedFileModule } from '../deposited_file/deposited_file.module';
import {
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
} from '../deposited_file/deposited_file_repository';
import {
  EXPECTED_DOCUMENT_REPOSITORY,
  DrizzleExpectedDocumentRepository,
  type ExpectedDocumentRepository,
} from '../deposit/expected_document_repository';
import { OBJECT_STORAGE, type ObjectStorage } from '../object_storage/object_storage';
import {
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import { GraphileScanQueue, SCAN_QUEUE, type ScanQueue } from './scan_queue';
import {
  DEPOSIT_RECONCILER,
  DepositReconciliationService,
  type DepositReconciler,
} from './reconcile_deposits';
import {
  OBJECT_ARRIVAL_RECORDER,
  ObjectArrivalRecordingService,
  type ObjectArrivalRecorder,
} from './record_object_arrival';
import {
  ClamavFileScanner,
  FILE_SCANNER,
  parse_clamav_connection_settings,
  type FileScanner,
} from './clamav_scanner';
import {
  DEPOSITED_FILE_SCANNER,
  DepositedFileScanService,
  type DepositedFileScanner,
} from './scan_deposited_file';

@Global()
@Module({
  imports: [DepositedFileModule],
  providers: [
    {
      provide: SCAN_QUEUE,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): ScanQueue => new GraphileScanQueue(database),
    },
    {
      provide: EXPECTED_DOCUMENT_REPOSITORY,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): ExpectedDocumentRepository =>
        new DrizzleExpectedDocumentRepository(database),
    },
    {
      provide: FILE_SCANNER,
      inject: [APPLICATION_ENVIRONMENT],
      useFactory: (environment: ApplicationEnvironment): FileScanner =>
        new ClamavFileScanner(parse_clamav_connection_settings(environment.clamav_endpoint)),
    },
    {
      provide: OBJECT_ARRIVAL_RECORDER,
      inject: [
        DEPOSITED_FILE_REPOSITORY,
        EXPECTED_DOCUMENT_REPOSITORY,
        ACTIVITY_EVENT_REPOSITORY,
        OBJECT_STORAGE,
        SCAN_QUEUE,
        CLOCK,
        APPLICATION_LOGGER,
      ],
      useFactory: (
        deposited_files: DepositedFileRepository,
        expected_documents: ExpectedDocumentRepository,
        activity_events: ActivityEventRepository,
        object_storage: ObjectStorage,
        scan_queue: ScanQueue,
        clock: Clock,
        logger: ApplicationLogger,
      ): ObjectArrivalRecorder =>
        new ObjectArrivalRecordingService({
          deposited_files,
          expected_documents,
          activity_events,
          object_storage,
          scan_queue,
          clock,
          logger,
        }),
    },
    {
      provide: DEPOSITED_FILE_SCANNER,
      inject: [
        DEPOSITED_FILE_REPOSITORY,
        EXPECTED_DOCUMENT_REPOSITORY,
        ACTIVITY_EVENT_REPOSITORY,
        OBJECT_STORAGE,
        FILE_SCANNER,
        CLOCK,
        APPLICATION_LOGGER,
      ],
      useFactory: (
        deposited_files: DepositedFileRepository,
        expected_documents: ExpectedDocumentRepository,
        activity_events: ActivityEventRepository,
        object_storage: ObjectStorage,
        file_scanner: FileScanner,
        clock: Clock,
        logger: ApplicationLogger,
      ): DepositedFileScanner =>
        new DepositedFileScanService({
          deposited_files,
          activity_events,
          expected_documents,
          object_storage,
          file_scanner,
          clock,
          logger,
        }),
    },
    {
      provide: DEPOSIT_RECONCILER,
      inject: [
        DEPOSITED_FILE_REPOSITORY,
        OBJECT_STORAGE,
        OBJECT_ARRIVAL_RECORDER,
        ACTIVITY_EVENT_REPOSITORY,
        SCAN_QUEUE,
        CLOCK,
        APPLICATION_LOGGER,
      ],
      useFactory: (
        deposited_files: DepositedFileRepository,
        object_storage: ObjectStorage,
        object_arrivals: ObjectArrivalRecorder,
        activity_events: ActivityEventRepository,
        scan_queue: ScanQueue,
        clock: Clock,
        logger: ApplicationLogger,
      ): DepositReconciler =>
        new DepositReconciliationService({
          deposited_files,
          object_storage,
          object_arrivals,
          activity_events,
          scan_queue,
          clock,
          logger,
        }),
    },
  ],
  exports: [
    SCAN_QUEUE,
    OBJECT_ARRIVAL_RECORDER,
    DEPOSITED_FILE_SCANNER,
    FILE_SCANNER,
    DEPOSIT_RECONCILER,
  ],
})
export class ScanModule {}
