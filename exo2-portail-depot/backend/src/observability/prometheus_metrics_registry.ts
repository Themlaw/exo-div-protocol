import { Counter, Gauge, Registry } from 'prom-client';
import type { ActivityEventType } from '../domain/activity_event';
import { ACTIVITY_EVENT_TYPES } from '../domain/activity_event';
import {
  RATE_LIMITED_SURFACES,
  type MetricsRegistry,
  type RateLimitedSurface,
  type RenderedMetrics,
  type ScanQueueSnapshot,
  type ScannerAvailability,
  type WorkerHealthSource,
} from './metrics';

// Le prefixe est le meme pour toutes les series du portail : il rend une regle
// d'alerte lisible sans avoir a deviner d'ou vient la metrique, et empeche une
// collision avec celles de MinIO ou de Postgres dans le meme Prometheus.
const METRIC_NAME_PREFIX = 'portail_';

export class PrometheusMetricsRegistry implements MetricsRegistry {
  // Un registre A NOUS, jamais le registre global par defaut de la
  // bibliotheque : un registre global est un etat partage entre les tests, et
  // deux instances de l'application dans le meme processus s'y marcheraient
  // dessus a l'enregistrement.
  readonly #registry = new Registry();

  readonly #activity_events: Counter<'type'>;
  readonly #unknown_access_link_attempts: Counter<string>;
  readonly #rate_limited_requests: Counter<'surface'>;

  // Creees seulement si la source est branchee : une jauge de file exposee par
  // un processus qui ne possede pas la file ferait doubler un `sum()`.
  #worker_health_source: WorkerHealthSource | null = null;
  #scan_queue_depth: Gauge<'state'> | null = null;
  #oldest_pending_job_age: Gauge<string> | null = null;
  #clamav_up: Gauge<string> | null = null;

  constructor() {
    this.#activity_events = new Counter({
      name: `${METRIC_NAME_PREFIX}activity_events_total`,
      help: "Evenements metier inscrits au journal d'activite, par type",
      labelNames: ['type'],
      registers: [this.#registry],
    });

    this.#unknown_access_link_attempts = new Counter({
      name: `${METRIC_NAME_PREFIX}unknown_access_link_attempts_total`,
      help: 'Tentatives sur un jeton de lien qui ne designe aucune demande',
      registers: [this.#registry],
    });

    this.#rate_limited_requests = new Counter({
      name: `${METRIC_NAME_PREFIX}rate_limited_requests_total`,
      help: 'Requetes refusees pour cadence excessive, par surface',
      labelNames: ['surface'],
      registers: [this.#registry],
    });

    // Toutes les series sont posees a zero au demarrage. Sans cela, une serie
    // n'apparait qu'au premier evenement : `rate()` n'a alors aucun point de
    // depart, et une alerte sur « aucun depot depuis une heure » ne peut pas se
    // declencher faute de serie a interroger.
    for (const type of ACTIVITY_EVENT_TYPES) {
      this.#activity_events.labels({ type }).inc(0);
    }
    for (const surface of RATE_LIMITED_SURFACES) {
      this.#rate_limited_requests.labels({ surface }).inc(0);
    }
    this.#unknown_access_link_attempts.inc(0);
  }

  count_activity_event(type: ActivityEventType): void {
    this.#activity_events.labels({ type }).inc();
  }

  count_unknown_access_link_attempt(): void {
    this.#unknown_access_link_attempts.inc();
  }

  count_rate_limited_request(surface: RateLimitedSurface): void {
    this.#rate_limited_requests.labels({ surface }).inc();
  }

  attach_worker_health_source(source: WorkerHealthSource): void {
    this.#worker_health_source = source;

    this.#scan_queue_depth = new Gauge({
      name: `${METRIC_NAME_PREFIX}scan_queue_depth`,
      help: "Travaux de la file de scan, par etat",
      labelNames: ['state'],
      registers: [this.#registry],
    });

    this.#oldest_pending_job_age = new Gauge({
      name: `${METRIC_NAME_PREFIX}scan_queue_oldest_pending_job_age_seconds`,
      help: "Age du plus vieux travail de scan en attente",
      registers: [this.#registry],
    });

    this.#clamav_up = new Gauge({
      name: `${METRIC_NAME_PREFIX}clamav_up`,
      help: 'clamd repond a la sonde de disponibilite',
      registers: [this.#registry],
    });
  }

  // Rafraichies ICI plutot que par un `collect` accroche a chaque jauge : les
  // trois valeurs de profondeur viennent d'une SEULE requete, et un collecteur
  // par jauge la rejouerait trois fois par collecte.
  async render(): Promise<RenderedMetrics> {
    await this.#refresh_worker_health_gauges();

    return {
      body: await this.#registry.metrics(),
      content_type: this.#registry.contentType,
    };
  }

  async #refresh_worker_health_gauges(): Promise<void> {
    const source: WorkerHealthSource | null = this.#worker_health_source;
    if (source === null) {
      return;
    }

    await this.#refresh_scan_queue_gauges(source);
    await this.#refresh_clamav_gauge(source);
  }

  // Une base injoignable ne doit pas emporter la page entiere : ce sont
  // justement les compteurs metier qu'on lira pour comprendre l'incident. Les
  // series de file DISPARAISSENT alors, plutot que de garder leur derniere
  // valeur ou de tomber a zero — les deux mentiraient, et `absent()` est une
  // condition d'alerte parfaitement lisible.
  async #refresh_scan_queue_gauges(source: WorkerHealthSource): Promise<void> {
    try {
      const snapshot: ScanQueueSnapshot = await source.read_scan_queue_snapshot();

      this.#scan_queue_depth?.set({ state: 'pending' }, snapshot.pending_job_count);
      this.#scan_queue_depth?.set({ state: 'running' }, snapshot.running_job_count);
      this.#scan_queue_depth?.set({ state: 'failed' }, snapshot.failed_job_count);
      this.#oldest_pending_job_age?.set(snapshot.oldest_pending_job_age_seconds);
    } catch {
      this.#scan_queue_depth?.reset();
      this.#oldest_pending_job_age?.remove();
    }
  }

  // Une sonde qui n'a pas pu s'executer n'est pas une sonde verte : l'echec
  // vaut indisponibilite, comme le fail closed du scanner lui-meme.
  async #refresh_clamav_gauge(source: WorkerHealthSource): Promise<void> {
    let availability: ScannerAvailability = 'unavailable';
    try {
      availability = await source.probe_clamav();
    } catch {
      availability = 'unavailable';
    }

    this.#clamav_up?.set(availability === 'available' ? 1 : 0);
  }
}
