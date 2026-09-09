import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APPLICATION_ENVIRONMENT } from './config/configuration.module';
import type { ApplicationEnvironment } from './config/environment';
import { APPLICATION_LOGGER } from './shared/logging/logging.module';
import { apply_http_hardening } from './shared/http_hardening';
import { describe_startup_failure } from './shared/startup_failure_report';
import { mount_lawyer_auth_handler } from './auth/mount_lawyer_auth';
import { LAWYER_AUTH, type LawyerAuth } from './auth/lawyer_auth';
import type { ApplicationLogger } from './shared/logging/application_logger';

const APPLICATION_LOG_CONTEXT = 'application';
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Le logger Nest par defaut ecrit en clair et hors de notre masquage : le
    // taire evite qu'une trace d'amorcage contourne `redact_log_fields`.
    logger: false,
    // Sans cela, Nest arrete lui-meme le processus sur une erreur d'amorcage,
    // apres l'avoir journalisee dans le logger qu'on vient de taire : une
    // configuration invalide en production tuait le conteneur SANS AUCUNE
    // SORTIE. La validation d'environnement existe pour rendre cette panne
    // lisible ; il faut donc en reprendre la main.
    abortOnError: false,
  });

  // Sans cela, `onApplicationShutdown` n'est jamais appele et la connexion
  // Postgres reste ouverte a l'arret du conteneur.
  app.enableShutdownHooks();

  apply_http_hardening(app.getHttpAdapter().getInstance());

  const logger: ApplicationLogger = app.get(APPLICATION_LOGGER);

  // Avant `listen`, donc avant que le routeur Nest ne soit en place : c'est
  // lui qui repondrait 404 sur /api/auth, ces chemins n'ayant aucun controleur.
  mount_lawyer_auth_handler(app, app.get<LawyerAuth>(LAWYER_AUTH), logger);
  // Le port passe par la validation de l'environnement comme le reste : une
  // lecture directe de `process.env` ici serait le seul reglage a echapper au
  // controle de demarrage, et une valeur illisible ferait ecouter le service
  // sur un port choisi par hasard.
  const environment: ApplicationEnvironment = app.get(APPLICATION_ENVIRONMENT);

  await app.listen(environment.http_port);
  logger.info(APPLICATION_LOG_CONTEXT, 'application demarree', {
    port: environment.http_port,
  });
}

bootstrap().catch((error: unknown): void => {
  process.stderr.write(`${describe_startup_failure(error)}\n`);
  process.exitCode = 1;
});
