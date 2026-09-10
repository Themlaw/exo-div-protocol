import type { DatabaseWriter } from '../db/database_connection';
import type {
  ActivityEvent,
  DepositRequestActivitySummary,
  NewActivityEvent,
} from '../domain/activity_event';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import type { MetricsRegistry } from './metrics';

// Un decorateur plutot qu'un appel au compteur sur chaque site d'ecriture : le
// journal est ecrit depuis une dizaine de services, et un compteur pose a la
// main serait oublie au premier evenement ajoute. Ici, ecrire au journal SUFFIT
// a etre compte — c'est la meme propriete que le decorateur donne au journal
// lui-meme vis-a-vis du metier.
export class MeteredActivityEventRepository implements ActivityEventRepository {
  constructor(
    private readonly delegate: ActivityEventRepository,
    private readonly metrics: MetricsRegistry,
  ) {}

  // Compte APRES l'ecriture, jamais avant : une insertion refusee ne doit pas
  // laisser de trace dans les metriques. Une transaction annulee plus tard,
  // elle, aura compte pour rien — un ecart minuscule et sans consequence pour
  // un compteur, la seule alternative etant de s'accrocher au commit.
  async record(event: NewActivityEvent, writer?: DatabaseWriter): Promise<void> {
    await this.delegate.record(event, writer);
    this.metrics.count_activity_event(event.type);
  }

  async list_for_deposit_request(
    deposit_request_id: string,
    page_size?: number,
  ): Promise<ActivityEvent[]> {
    return this.delegate.list_for_deposit_request(deposit_request_id, page_size);
  }

  async summarize_deposit_requests(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, DepositRequestActivitySummary>> {
    return this.delegate.summarize_deposit_requests(deposit_request_ids);
  }

  async redact_client_ip_recorded_before(instant: Date): Promise<number> {
    return this.delegate.redact_client_ip_recorded_before(instant);
  }
}
