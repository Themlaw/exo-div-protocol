import { Global, Module } from '@nestjs/common';
import { APPLICATION_ENVIRONMENT } from '../../config/configuration.module';
import type { ApplicationEnvironment } from '../../config/environment';
import {
  resolve_minimum_log_level,
  StructuredApplicationLogger,
  type ApplicationLogger,
} from './application_logger';

export const APPLICATION_LOGGER: unique symbol = Symbol('APPLICATION_LOGGER');

// Le niveau minimal se deduit de NODE_ENV, sans variable dediee : un niveau
// reglable a chaud est une facon d'activer le debug en production sans l'avoir
// decide, et c'est la que le risque de fuite est le plus grand.
@Global()
@Module({
  providers: [
    {
      provide: APPLICATION_LOGGER,
      inject: [APPLICATION_ENVIRONMENT],
      useFactory: (environment: ApplicationEnvironment): ApplicationLogger =>
        new StructuredApplicationLogger(
          resolve_minimum_log_level(environment.node_environment),
        ),
    },
  ],
  exports: [APPLICATION_LOGGER],
})
export class LoggingModule {}
