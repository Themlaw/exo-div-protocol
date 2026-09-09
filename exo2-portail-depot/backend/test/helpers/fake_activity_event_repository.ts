import type {
  ActivityEvent,
  ActivityEventType,
  DepositRequestActivitySummary,
  NewActivityEvent,
} from '../../src/domain/activity_event';
import { summarize_deposit_request_activity } from '../../src/domain/activity_event';
import type { ActivityEventRepository } from '../../src/activity/activity_event_repository';

// Garde les evenements dans leur ordre d'ecriture : un test du journal affirme
// autant la SUITE des evenements que leur presence — « PIN refuse puis lien
// bloque » n'est pas la meme histoire que l'inverse.
export class FakeActivityEventRepository implements ActivityEventRepository {
  readonly recorded_events: NewActivityEvent[] = [];

  recorded_types(): ActivityEventType[] {
    return this.recorded_events.map((event: NewActivityEvent): ActivityEventType => event.type);
  }

  async record(event: NewActivityEvent): Promise<void> {
    this.recorded_events.push(event);
  }

  async list_for_deposit_request(deposit_request_id: string): Promise<ActivityEvent[]> {
    return this.recorded_events
      .filter((event: NewActivityEvent): boolean => event.deposit_request_id === deposit_request_id)
      .map(
        (event: NewActivityEvent, index: number): ActivityEvent => ({
          ...event,
          id: `activity-event-${index}`,
        }),
      )
      .reverse();
  }

  async summarize_deposit_requests(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, DepositRequestActivitySummary>> {
    const summaries = new Map<string, DepositRequestActivitySummary>();

    for (const deposit_request_id of deposit_request_ids) {
      const summary: DepositRequestActivitySummary = summarize_deposit_request_activity(
        await this.list_for_deposit_request(deposit_request_id),
      );

      if (summary.has_problem) {
        summaries.set(deposit_request_id, summary);
      }
    }

    return summaries;
  }

  async redact_client_ip_recorded_before(instant: Date): Promise<number> {
    let redacted = 0;

    for (const event of this.recorded_events) {
      if (event.client_ip !== null && event.occurred_at < instant) {
        event.client_ip = null;
        redacted += 1;
      }
    }

    return redacted;
  }
}
