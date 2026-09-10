import { NestFactory } from '@nestjs/core';
import { parseCrontab, run, type ParsedCronItem, type Runner } from 'graphile-worker';
import { AppModule } from './app.module';
import { APPLICATION_ENVIRONMENT } from './config/configuration.module';
import type { ApplicationEnvironment } from './config/environment';
import { APPLICATION_LOGGER } from './shared/logging/logging.module';
import type { ApplicationLogger } from './shared/logging/application_logger';
import { describe_startup_failure } from './shared/startup_failure_report';
import {
  RECONCILE_DEPOSITS_TASK,
  SCAN_DEPOSITED_FILE_TASK,
  type ScanJobPayload,
} from './scan/scan_queue';
import {
  DEPOSIT_RECONCILER,
  RECONCILIATION_LOG_CONTEXT,
  type DepositReconciler,
} from './scan/reconcile_deposits';
import { SCAN_QUEUE_SCHEMA, run_scan_queue_migrations } from './scan/scan_queue_migrations';
import {
  SCAN_QUEUE_HEALTH_READER,
  type ScanQueueHealthReader,
} from './scan/scan_queue_health';
import { FILE_SCANNER, type FileScanner } from './scan/clamav_scanner';
import { CLOCK, type Clock } from './shared/clock';
import { METRICS_REGISTRY, type MetricsRegistry } from './observability/metrics';
import { ScanChainHealthSource } from './observability/scan_chain_health_source';
import {
  start_worker_metrics_listener,
  type WorkerMetricsListener,
} from './observability/worker_metrics_listener';
import {
  DEPOSITED_FILE_SCANNER,
  SCAN_LOG_CONTEXT,
  type DepositedFileScanner,
  type ScanOutcome,
} from './scan/scan_deposited_file';

const WORKER_LOG_CONTEXT = 'worker';

// Un scan a la fois : chacun tient un flux de vingt megaoctets ouvert vers
// clamd, qui est lui-meme le goulot. En lancer quatre ne scannerait pas plus
// vite et multiplierait par quatre la memoire retenue.
const SCAN_CONCURRENCY = 1;

// Toutes les quinze minutes. Le balayage n'est pas un chemin nominal : il repare
// ce que des evenements perdus ont laisse en plan, et le faire tourner plus
// souvent ne ferait que relire les memes lignes. `?max=1` interdit qu'une passe
// lente en croise une autre, ce qui ferait ramasser deux fois les memes objets.
const RECONCILIATION_CRONTAB = `*/15 * * * * ${RECONCILE_DEPOSITS_TASK} ?max=1`;

// Le worker est un PROCESSUS A LUI. Il ne sert aucune requete : un scan qui
// s'emballe ne doit pas peser sur la connexion d'un avocat, et le conteneur qui
// le porte n'est joignable par personne.
//
// Il monte pourtant le meme `AppModule` — donc la meme base, le meme stockage,
// les memes reglages — parce que deux cablages separes auraient fini par
// diverger sur un detail qu'aucun test n'aurait couvert.
async function bootstrap_worker(): Promise<void> {
  const application_context = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  application_context.enableShutdownHooks();

  const environment: ApplicationEnvironment = application_context.get(APPLICATION_ENVIRONMENT);
  const logger: ApplicationLogger = application_context.get(APPLICATION_LOGGER);
  const scanner: DepositedFileScanner = application_context.get(DEPOSITED_FILE_SCANNER);
  const reconciler: DepositReconciler = application_context.get(DEPOSIT_RECONCILER);

  await run_scan_queue_migrations(environment.database_url, logger);

  // Les jauges de file sont branchees ICI et nulle part ailleurs. L'API partage
  // la meme base et pourrait les lire, mais c'est le travailleur qui possede la
  // file : les exposer des deux cotes ferait doubler un `sum()` sur la
  // profondeur. Cette ligne EST la decision, et elle vit a la racine du seul
  // processus qui a le droit de la prendre.
  const metrics: MetricsRegistry = application_context.get(METRICS_REGISTRY);
  metrics.attach_worker_health_source(
    new ScanChainHealthSource({
      scan_queue: application_context.get<ScanQueueHealthReader>(SCAN_QUEUE_HEALTH_READER),
      file_scanner: application_context.get<FileScanner>(FILE_SCANNER),
      clock: application_context.get<Clock>(CLOCK),
    }),
  );

  // Le travailleur ne sert aucune requete metier, mais il ecrit lui-meme au
  // journal d'activite pendant un scan : sans cette ecoute, ses compteurs
  // vivaient dans un registre que personne ne collectait.
  const metrics_listener: WorkerMetricsListener = await start_worker_metrics_listener({
    metrics,
    shared_secret: environment.internal_storage_webhook_secret,
    port: environment.worker_metrics_port,
    logger,
  });

  const parsed_reconciliation_schedule: ParsedCronItem[] = parseCrontab(RECONCILIATION_CRONTAB);

  const runner: Runner = await run({
    connectionString: environment.database_url,
    schema: SCAN_QUEUE_SCHEMA,
    concurrency: SCAN_CONCURRENCY,
    // Nest gere deja l'arret : lui laisser poser ses propres gestionnaires de
    // signaux ferait deux arrets concurrents sur le meme processus.
    noHandleSignals: true,
    parsedCronItems: parsed_reconciliation_schedule,
    taskList: {
      [RECONCILE_DEPOSITS_TASK]: async (): Promise<void> => {
        await reconciler.reconcile();
      },
      [SCAN_DEPOSITED_FILE_TASK]: async (payload: unknown): Promise<void> => {
        const { deposited_file_id } = payload as ScanJobPayload;
        const outcome: ScanOutcome = await scanner.scan(deposited_file_id);

        logger.info(SCAN_LOG_CONTEXT, 'scan termine', {
          deposited_file_id,
          outcome: outcome.kind,
        });

        // Le job ECHOUE quand le scanner n'a rien pu dire : c'est ce qui le
        // fait rejouer avec le recul exponentiel de graphile-worker. Le rendre
        // reussi laisserait la piece en attente pour toujours — un fichier non
        // scanne, donc jamais servi, et personne pour s'en apercevoir.
        if (outcome.kind === 'scanner_unavailable') {
          throw new Error(`scanner indisponible pour la piece ${deposited_file_id}`);
        }
      },
    },
  });

  const stop_worker = async (): Promise<void> => {
    await runner.stop();
    // Fermee AVANT le contexte : la page de metriques lit la base, et repondre
    // a une derniere collecte sur une connexion deja fermee ferait finir le
    // conteneur sur une erreur qui n'a rien a voir avec l'arret.
    await metrics_listener.close();
    await application_context.close();
  };

  process.once('SIGTERM', stop_worker);
  process.once('SIGINT', stop_worker);

  logger.info(WORKER_LOG_CONTEXT, 'travailleur de scan demarre', {
    concurrency: SCAN_CONCURRENCY,
    metrics_port: metrics_listener.port,
    reconciliation_context: RECONCILIATION_LOG_CONTEXT,
    reconciliation_crontab: RECONCILIATION_CRONTAB,
  });

  await runner.promise;
}

bootstrap_worker().catch((error: unknown): void => {
  // Meme traitement que l'API : une configuration invalide doit rendre un
  // message lisible plutot que tuer le conteneur en silence.
  process.stderr.write(`${describe_startup_failure(error)}\n`);
  process.exitCode = 1;
});
