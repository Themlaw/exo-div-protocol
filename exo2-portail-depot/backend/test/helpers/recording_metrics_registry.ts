import type { ActivityEventType } from '../../src/domain/activity_event';
import type {
  MetricsRegistry,
  RateLimitedSurface,
  RenderedMetrics,
  WorkerHealthSource,
} from '../../src/observability/metrics';

// Enregistre les appels sans rien agreger : ce que les tests d'un appelant
// veulent savoir, c'est s'il a COMPTE le fait, pas ce que le registre reel en
// aurait fait — cela, c'est la spec du registre qui le dit.
export class RecordingMetricsRegistry implements MetricsRegistry {
  readonly counted_activity_events: ActivityEventType[] = [];
  readonly counted_rate_limited_surfaces: RateLimitedSurface[] = [];
  counted_unknown_access_link_attempts = 0;

  count_activity_event(type: ActivityEventType): void {
    this.counted_activity_events.push(type);
  }

  count_unknown_access_link_attempt(): void {
    this.counted_unknown_access_link_attempts += 1;
  }

  count_rate_limited_request(surface: RateLimitedSurface): void {
    this.counted_rate_limited_surfaces.push(surface);
  }

  attached_worker_health_sources = 0;

  attach_worker_health_source(_source: WorkerHealthSource): void {
    this.attached_worker_health_sources += 1;
  }

  async render(): Promise<RenderedMetrics> {
    return { body: '', content_type: 'text/plain' };
  }
}
