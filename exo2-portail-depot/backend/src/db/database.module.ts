import { Global, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { APPLICATION_LOGGER } from '../shared/logging/logging.module';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import {
  open_database_connection,
  DATABASE_CONNECTION,
  DATABASE_LOG_CONTEXT,
  type ApplicationDatabase,
  type DatabaseConnection,
} from './database_connection';
import { run_database_migrations } from './run_database_migrations';

export const APPLICATION_DATABASE: unique symbol = Symbol('APPLICATION_DATABASE');

// Les migrations tournent au demarrage, pas depuis une commande separee : le
// schema et le code qui le lit sont livres dans la meme image, et les faire
// diverger le temps d'une etape manuelle est precisement l'incident qu'on
// evite. Le verrou consultatif de `run_database_migrations` rend l'operation
// sure meme quand plusieurs instances demarrent ensemble.
@Injectable()
export class DatabaseMigrationRunner implements OnModuleInit {
  constructor(
    @Inject(APPLICATION_DATABASE) private readonly database: ApplicationDatabase,
    @Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.info(DATABASE_LOG_CONTEXT, 'execution des migrations');
    await run_database_migrations(this.database);
    this.logger.info(DATABASE_LOG_CONTEXT, 'migrations a jour');
  }
}

// La fermeture passe par `onApplicationShutdown` et non `onModuleDestroy` :
// elle doit survenir apres l'arret des modules qui interrogent encore la base
// pendant leur propre arret.
@Injectable()
export class DatabaseConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly connection: DatabaseConnection,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      inject: [APPLICATION_ENVIRONMENT, APPLICATION_LOGGER],
      useFactory: (
        environment: ApplicationEnvironment,
        logger: ApplicationLogger,
      ): DatabaseConnection => open_database_connection(environment.database_url, logger),
    },
    {
      // Le reste de l'application injecte la base, pas la connexion : seule
      // l'infrastructure a besoin de pouvoir la fermer.
      provide: APPLICATION_DATABASE,
      inject: [DATABASE_CONNECTION],
      useFactory: (connection: DatabaseConnection): ApplicationDatabase => connection.database,
    },
    DatabaseMigrationRunner,
    DatabaseConnectionCloser,
  ],
  exports: [DATABASE_CONNECTION, APPLICATION_DATABASE],
})
export class DatabaseModule {}
