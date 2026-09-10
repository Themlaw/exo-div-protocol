import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { METRICS_PATH, INTERNAL_METRICS_SCRAPE_HEADER_NAME } from '../auth/auth_http_contract';
import { matches_internal_shared_secret } from '../auth/internal_shared_secret';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import type { MetricsRegistry, RenderedMetrics } from './metrics';

export const WORKER_METRICS_LOG_CONTEXT = 'worker_metrics';

export interface WorkerMetricsListener {
  readonly port: number;
  close(): Promise<void>;
}

export interface WorkerMetricsListenerDependencies {
  metrics: MetricsRegistry;
  shared_secret: string;
  port: number;
  logger: ApplicationLogger;
}

// `node:http` nu, sans Nest ni cadre : le travailleur ne sert AUCUNE requete
// metier, et monter un serveur d'application pour une seule page de metriques
// lui donnerait une surface qu'il n'a aucune raison d'avoir.
//
// Une seule route, un seul verbe. Tout le reste rend un 404 muet — pas un 405,
// qui confirmerait que le chemin existe. Le travailleur ne dit rien a qui n'a
// pas le secret, et rien de plus a qui l'a mais frappe ailleurs.
export async function start_worker_metrics_listener(
  dependencies: WorkerMetricsListenerDependencies,
): Promise<WorkerMetricsListener> {
  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse): void => {
      void serve_metrics_request(dependencies, request, response);
    },
  );

  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject);
    // Boucle locale uniquement serait trop restrictif : dans le compose, le
    // collecteur atteint le conteneur par le reseau interne, donc par une autre
    // interface. C'est la publication du port qui limite, pas le liage.
    server.listen(dependencies.port, resolve);
  });

  const bound_port: number = (server.address() as AddressInfo).port;

  dependencies.logger.info(WORKER_METRICS_LOG_CONTEXT, 'exposition des metriques ouverte', {
    port: bound_port,
  });

  return {
    port: bound_port,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject): void => {
        server.close((error: Error | undefined): void => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      // Sans cela, une connexion gardee ouverte par le collecteur retiendrait
      // la fermeture jusqu'a son expiration, et l'arret du conteneur trainerait
      // pour rien.
      server.closeAllConnections();
    },
  };
}

async function serve_metrics_request(
  dependencies: WorkerMetricsListenerDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'GET' || read_request_path(request) !== METRICS_PATH) {
    response.writeHead(404).end();
    return;
  }

  const presented_secret: string | string[] | undefined =
    request.headers[INTERNAL_METRICS_SCRAPE_HEADER_NAME];

  // Meme refus, exactement, que la route de l'API : un 401 nu, sans corps qui
  // distinguerait « en-tete absent » de « secret faux ».
  if (
    typeof presented_secret !== 'string' ||
    !matches_internal_shared_secret(presented_secret, dependencies.shared_secret)
  ) {
    response.writeHead(401).end();
    return;
  }

  try {
    const rendered: RenderedMetrics = await dependencies.metrics.render();
    response.writeHead(200, { 'content-type': rendered.content_type }).end(rendered.body);
  } catch (error: unknown) {
    // La cause reste dans le journal : la transmettre au collecteur la rendrait
    // lisible par tout ce qui presente le secret.
    dependencies.logger.error(WORKER_METRICS_LOG_CONTEXT, 'rendu des metriques impossible', {
      error,
    });
    response.writeHead(500).end();
  }
}

// Le chemin SEUL, sans sa chaine de requete : Prometheus n'en ajoute pas, mais
// `/metrics?x=1` doit etre servi comme `/metrics` plutot que rendre un 404 que
// personne ne saurait expliquer.
function read_request_path(request: IncomingMessage): string {
  return (request.url ?? '').split('?')[0] ?? '';
}
