import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APPLICATION_LOGGER } from './shared/logging/logging.module';
import { mount_lawyer_auth_handler } from './auth/mount_lawyer_auth';
import { LAWYER_AUTH, type LawyerAuth } from './auth/lawyer_auth';
import type { ApplicationLogger } from './shared/logging/application_logger';

const APPLICATION_LOG_CONTEXT = 'application';
const DEFAULT_HTTP_PORT = 3000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Le logger Nest par defaut ecrit en clair et hors de notre masquage : le
    // taire evite qu'une trace d'amorcage contourne `redact_log_fields`.
    logger: false,
  });

  // Sans cela, `onApplicationShutdown` n'est jamais appele et la connexion
  // Postgres reste ouverte a l'arret du conteneur.
  app.enableShutdownHooks();

  const logger: ApplicationLogger = app.get(APPLICATION_LOGGER);

  // Avant `listen`, donc avant que le routeur Nest ne soit en place : c'est
  // lui qui repondrait 404 sur /api/auth, ces chemins n'ayant aucun controleur.
  mount_lawyer_auth_handler(app, app.get<LawyerAuth>(LAWYER_AUTH), logger);
  const port: number = Number(process.env.PORT ?? DEFAULT_HTTP_PORT);

  await app.listen(port);
  logger.info(APPLICATION_LOG_CONTEXT, 'application demarree', { port });
}

void bootstrap();
