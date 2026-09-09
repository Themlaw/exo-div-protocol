import { Global, Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { APPLICATION_LOGGER } from '../shared/logging/logging.module';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import { MinioObjectStorage } from './minio_object_storage';
import {
  OBJECT_STORAGE,
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
} from './object_storage';

export const OBJECT_STORAGE_LOG_CONTEXT = 'object_storage';

// Les buckets sont crees au demarrage, comme le compte de demonstration : une
// installation ne doit exiger aucune commande qu'on peut oublier de lancer.
// Idempotent par construction, donc rejouable a chaque redemarrage.
@Injectable()
export class ObjectStorageBucketBootstrapper implements OnApplicationBootstrap {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly object_storage: ObjectStorage,
    @Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.object_storage.ensure_buckets_exist();

    this.logger.info(OBJECT_STORAGE_LOG_CONTEXT, 'buckets de depot disponibles', {
      quarantine_bucket: QUARANTINE_BUCKET_NAME,
      verified_bucket: VERIFIED_BUCKET_NAME,
    });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [APPLICATION_ENVIRONMENT],
      useFactory: (environment: ApplicationEnvironment): ObjectStorage =>
        new MinioObjectStorage({
          endpoint_url: environment.minio_endpoint,
          access_key: environment.minio_root_user,
          secret_key: environment.minio_root_password,
        }),
    },
    ObjectStorageBucketBootstrapper,
  ],
  exports: [OBJECT_STORAGE],
})
export class ObjectStorageModule {}
