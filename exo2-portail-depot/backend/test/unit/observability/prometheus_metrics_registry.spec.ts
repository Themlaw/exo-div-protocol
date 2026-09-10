import { PrometheusMetricsRegistry } from '../../../src/observability/prometheus_metrics_registry';
import {
  RATE_LIMITED_SURFACES,
  type MetricsRegistry,
  type RenderedMetrics,
  type ScanQueueSnapshot,
  type ScannerAvailability,
  type WorkerHealthSource,
} from '../../../src/observability/metrics';
import { ACTIVITY_EVENT_TYPES } from '../../../src/domain/activity_event';

async function render_body(registry: MetricsRegistry): Promise<string> {
  const rendered: RenderedMetrics = await registry.render();
  return rendered.body;
}

// Une ligne d'exposition Prometheus, sans son nom de metrique ni ses accolades :
// lire la valeur en la cherchant a la main dans chaque test rendrait l'echec
// illisible.
function read_series_value(body: string, series: string): number | undefined {
  const line: string | undefined = body
    .split('\n')
    .find((candidate: string): boolean => candidate.startsWith(`${series} `));

  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('Registre de metriques Prometheus', () => {
  it('pose toutes les series a zero avant le moindre evenement', async () => {
    const body: string = await render_body(new PrometheusMetricsRegistry());

    for (const type of ACTIVITY_EVENT_TYPES) {
      expect(read_series_value(body, `portail_activity_events_total{type="${type}"}`)).toBe(0);
    }
    for (const surface of RATE_LIMITED_SURFACES) {
      expect(
        read_series_value(body, `portail_rate_limited_requests_total{surface="${surface}"}`),
      ).toBe(0);
    }
    expect(read_series_value(body, 'portail_unknown_access_link_attempts_total')).toBe(0);
  });

  it("compte l'evenement metier sous son propre type", async () => {
    const registry = new PrometheusMetricsRegistry();

    registry.count_activity_event('deposited_file_received');
    registry.count_activity_event('deposited_file_received');
    registry.count_activity_event('client_pin_rejected');

    const body: string = await render_body(registry);

    expect(
      read_series_value(body, 'portail_activity_events_total{type="deposited_file_received"}'),
    ).toBe(2);
    expect(
      read_series_value(body, 'portail_activity_events_total{type="client_pin_rejected"}'),
    ).toBe(1);
  });

  it('ventile les refus de cadence par surface', async () => {
    const registry = new PrometheusMetricsRegistry();

    registry.count_rate_limited_request('lawyer_login');
    registry.count_rate_limited_request('client_pin');
    registry.count_rate_limited_request('client_pin');

    const body: string = await render_body(registry);

    expect(
      read_series_value(body, 'portail_rate_limited_requests_total{surface="lawyer_login"}'),
    ).toBe(1);
    expect(
      read_series_value(body, 'portail_rate_limited_requests_total{surface="client_pin"}'),
    ).toBe(2);
  });

  it('compte les tentatives sur un jeton qui ne designe aucune demande', async () => {
    const registry = new PrometheusMetricsRegistry();

    registry.count_unknown_access_link_attempt();
    registry.count_unknown_access_link_attempt();
    registry.count_unknown_access_link_attempt();

    expect(
      read_series_value(await render_body(registry), 'portail_unknown_access_link_attempts_total'),
    ).toBe(3);
  });

  // La preuve qu'aucun registre global n'est en jeu : deux instances dans le
  // meme processus, c'est exactement ce que font deux tests d'integration a la
  // suite, et un etat partage les rendrait dependants de leur ordre.
  it("deux registres ne partagent aucun etat", async () => {
    const first = new PrometheusMetricsRegistry();
    const second = new PrometheusMetricsRegistry();

    first.count_unknown_access_link_attempt();

    expect(
      read_series_value(await render_body(first), 'portail_unknown_access_link_attempts_total'),
    ).toBe(1);
    expect(
      read_series_value(await render_body(second), 'portail_unknown_access_link_attempts_total'),
    ).toBe(0);
  });

  it("n'expose aucune serie etrangere au portail", async () => {
    const body: string = await render_body(new PrometheusMetricsRegistry());

    const exposed_series: readonly string[] = body
      .split('\n')
      .filter((line: string): boolean => line.length > 0 && !line.startsWith('#'))
      .map((line: string): string => line.split(/[ {]/)[0]);

    for (const series of exposed_series) {
      expect(series.startsWith('portail_')).toBe(true);
    }
  });

  it("annonce le type de contenu du format d'exposition", async () => {
    const rendered: RenderedMetrics = await new PrometheusMetricsRegistry().render();

    expect(rendered.content_type).toContain('text/plain');
    expect(rendered.content_type).toContain('version=');
  });

  // --- Les jauges du travailleur ---
  //
  // Elles ne sont pas comptees mais LUES, et leur source vit dans le processus
  // qui possede la file. Passer `null` est donc le cas de l'API, et c'est ce
  // qui garantit qu'un `sum()` sur la profondeur de file ne double pas.
  describe('Jauges de sante du travailleur', () => {
    function build_health_source(overrides: {
      snapshot?: ScanQueueSnapshot;
      clamav?: ScannerAvailability;
      on_read?: () => void;
    } = {}): WorkerHealthSource {
      return {
        read_scan_queue_snapshot: async (): Promise<ScanQueueSnapshot> => {
          overrides.on_read?.();
          return (
            overrides.snapshot ?? {
              pending_job_count: 0,
              running_job_count: 0,
              failed_job_count: 0,
              oldest_pending_job_age_seconds: 0,
            }
          );
        },
        probe_clamav: async (): Promise<ScannerAvailability> => overrides.clamav ?? 'available',
      };
    }

    it("n'expose aucune serie de file quand aucune source n'est branchee", async () => {
      const body: string = await render_body(new PrometheusMetricsRegistry());

      expect(body).not.toContain('portail_scan_queue_depth');
      expect(body).not.toContain('portail_scan_queue_oldest_pending_job_age_seconds');
      expect(body).not.toContain('portail_clamav_up');
    });

    // La source est BRANCHEE, jamais passee au constructeur : c'est
    // `worker_main.ts` qui la branche, et l'API ne la branche pas. La decision
    // « qui possede la file » est ainsi visible a la racine du processus.
    function build_registry_watching(source: WorkerHealthSource): PrometheusMetricsRegistry {
      const registry = new PrometheusMetricsRegistry();
      registry.attach_worker_health_source(source);
      return registry;
    }

    it('expose la profondeur de file lue, ventilee par etat', async () => {
      const registry = build_registry_watching(
        build_health_source({
          snapshot: {
            pending_job_count: 7,
            running_job_count: 1,
            failed_job_count: 2,
            oldest_pending_job_age_seconds: 0,
          },
        }),
      );

      const body: string = await render_body(registry);

      expect(read_series_value(body, 'portail_scan_queue_depth{state="pending"}')).toBe(7);
      expect(read_series_value(body, 'portail_scan_queue_depth{state="running"}')).toBe(1);
      expect(read_series_value(body, 'portail_scan_queue_depth{state="failed"}')).toBe(2);
    });

    it("expose l'age du plus vieux job en attente", async () => {
      const registry = build_registry_watching(
        build_health_source({
          snapshot: {
            pending_job_count: 1,
            running_job_count: 0,
            failed_job_count: 0,
            oldest_pending_job_age_seconds: 942,
          },
        }),
      );

      expect(
        read_series_value(
          await render_body(registry),
          'portail_scan_queue_oldest_pending_job_age_seconds',
        ),
      ).toBe(942);
    });

    it("rend zero pour l'age quand la file est vide", async () => {
      const registry = build_registry_watching(build_health_source());

      expect(
        read_series_value(
          await render_body(registry),
          'portail_scan_queue_oldest_pending_job_age_seconds',
        ),
      ).toBe(0);
    });

    it('traduit la sonde de clamd en 1 ou 0', async () => {
      const available = build_registry_watching(build_health_source({ clamav: 'available' }));
      const unavailable = build_registry_watching(build_health_source({ clamav: 'unavailable' }));

      expect(read_series_value(await render_body(available), 'portail_clamav_up')).toBe(1);
      expect(read_series_value(await render_body(unavailable), 'portail_clamav_up')).toBe(0);
    });

    // Une jauge lue dans un cache ment sur son age, et c'est precisement l'age
    // du plus vieux job qu'on alerte.
    it('interroge la source a chaque rendu, sans jamais la mettre en cache', async () => {
      let read_count = 0;
      const registry = build_registry_watching(
        build_health_source({
          on_read: (): void => {
            read_count += 1;
          },
        }),
      );

      await render_body(registry);
      await render_body(registry);

      expect(read_count).toBe(2);
    });

    // Une base momentanement injoignable ne doit pas emporter la page entiere :
    // ce sont justement les compteurs metier qu'on lira pour comprendre
    // l'incident.
    it('rend quand meme les compteurs metier quand la source est en panne', async () => {
      const registry = build_registry_watching({
        read_scan_queue_snapshot: async (): Promise<ScanQueueSnapshot> => {
          throw new Error('base injoignable');
        },
        probe_clamav: async (): Promise<ScannerAvailability> => {
          throw new Error('sonde impossible');
        },
      });
      registry.count_unknown_access_link_attempt();

      const body: string = await render_body(registry);

      expect(read_series_value(body, 'portail_unknown_access_link_attempts_total')).toBe(1);
      // Une sonde qui n'a pas pu s'executer n'est pas une sonde verte.
      expect(read_series_value(body, 'portail_clamav_up')).toBe(0);
      expect(body).not.toContain('portail_scan_queue_depth{');
    });
  });
});