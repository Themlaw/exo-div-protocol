import {
  start_worker_metrics_listener,
  type WorkerMetricsListener,
} from '../../../src/observability/worker_metrics_listener';
import { PrometheusMetricsRegistry } from '../../../src/observability/prometheus_metrics_registry';
import type {
  ScanQueueSnapshot,
  ScannerAvailability,
  WorkerHealthSource,
} from '../../../src/observability/metrics';
import { INTERNAL_METRICS_SCRAPE_HEADER_NAME } from '../../../src/auth/auth_http_contract';
import type { ApplicationLogger } from '../../../src/shared/logging/application_logger';

const SHARED_SECRET = 'un-secret-partage-de-longueur-tout-a-fait-raisonnable-pour-un-test';

function silent_logger(): ApplicationLogger {
  const ignore = (): void => undefined;
  return { debug: ignore, info: ignore, warn: ignore, error: ignore };
}

function build_worker_registry(): PrometheusMetricsRegistry {
  const registry = new PrometheusMetricsRegistry();
  registry.attach_worker_health_source(STEADY_HEALTH_SOURCE);
  return registry;
}

const STEADY_HEALTH_SOURCE: WorkerHealthSource = {
  read_scan_queue_snapshot: async (): Promise<ScanQueueSnapshot> => ({
    pending_job_count: 3,
    running_job_count: 1,
    failed_job_count: 0,
    oldest_pending_job_age_seconds: 42,
  }),
  probe_clamav: async (): Promise<ScannerAvailability> => 'available',
};

describe('Ecoute de metriques du travailleur', () => {
  let listener: WorkerMetricsListener;

  async function call(
    path: string,
    options: { method?: string; secret?: string } = {},
  ): Promise<{ status: number; body: string; content_type: string | null }> {
    const response = await fetch(`http://127.0.0.1:${listener.port}${path}`, {
      method: options.method ?? 'GET',
      headers:
        options.secret === undefined
          ? {}
          : { [INTERNAL_METRICS_SCRAPE_HEADER_NAME]: options.secret },
    });

    return {
      status: response.status,
      body: await response.text(),
      content_type: response.headers.get('content-type'),
    };
  }

  beforeAll(async () => {
    listener = await start_worker_metrics_listener({
      metrics: build_worker_registry(),
      shared_secret: SHARED_SECRET,
      // Port ephemere : deux suites qui se disputeraient un port fixe
      // echoueraient a la premiere execution en parallele.
      port: 0,
      logger: silent_logger(),
    });
  });

  afterAll(async () => {
    await listener.close();
  });

  it('refuse par 401 une collecte sans secret', async () => {
    expect((await call('/metrics')).status).toBe(401);
  });

  it('refuse un mauvais secret exactement comme un secret absent', async () => {
    const without_secret = await call('/metrics');
    const with_wrong_secret = await call('/metrics', { secret: 'ce-secret-est-faux' });

    expect(with_wrong_secret.status).toBe(401);
    expect(with_wrong_secret.status).toBe(without_secret.status);
    expect(with_wrong_secret.body).toBe(without_secret.body);
  });

  it("rend l'exposition du travailleur au collecteur muni du secret", async () => {
    const response = await call('/metrics', { secret: SHARED_SECRET });

    expect(response.status).toBe(200);
    expect(response.content_type).toContain('text/plain');
    expect(response.body).toContain('portail_scan_queue_depth');
    expect(response.body).toContain('portail_clamav_up');
  });

  // Le travailleur ecrit lui-meme au journal d'activite pendant un scan : sans
  // cette ecoute, ces evenements etaient comptes dans un registre que personne
  // ne collectait.
  it('rend aussi les compteurs metier que le travailleur produit', async () => {
    const response = await call('/metrics', { secret: SHARED_SECRET });

    expect(response.body).toContain('portail_activity_events_total');
  });

  it("ne porte aucun identifiant : ses etiquettes sont des enumerations fermees", async () => {
    const response = await call('/metrics', { secret: SHARED_SECRET });

    expect(response.body).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  // 404 et non 405 : un 405 confirmerait que le chemin existe. Le travailleur
  // ne dit rien a qui n'a pas le secret, et rien de plus a qui l'a mais frappe
  // ailleurs.
  it('rend un 404 muet sur tout autre chemin, meme avec le bon secret', async () => {
    const response = await call('/tout-autre-chose', { secret: SHARED_SECRET });

    expect(response.status).toBe(404);
    expect(response.body).toBe('');
  });

  it('rend un 404 muet sur une autre methode que GET, meme avec le bon secret', async () => {
    const response = await call('/metrics', { method: 'POST', secret: SHARED_SECRET });

    expect(response.status).toBe(404);
    expect(response.body).toBe('');
  });
});

// Ferme dans son propre `describe` : le harnais ci-dessus garde l'ecoute
// ouverte pour toute sa duree, et une suite ne peut pas affirmer a la fois
// qu'un serveur repond et qu'il est ferme.
describe('Arret de l ecoute de metriques', () => {
  it('libere son port a la fermeture', async () => {
    const listener: WorkerMetricsListener = await start_worker_metrics_listener({
      metrics: build_worker_registry(),
      shared_secret: SHARED_SECRET,
      port: 0,
      logger: silent_logger(),
    });
    const closed_port: number = listener.port;

    await listener.close();

    await expect(fetch(`http://127.0.0.1:${closed_port}/metrics`)).rejects.toThrow();
  });
});
