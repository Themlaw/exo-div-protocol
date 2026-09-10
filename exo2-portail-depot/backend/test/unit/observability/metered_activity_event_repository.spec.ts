import { MeteredActivityEventRepository } from '../../../src/observability/metered_activity_event_repository';
import type { ActivityEventRepository } from '../../../src/activity/activity_event_repository';
import type { NewActivityEvent } from '../../../src/domain/activity_event';
import type { DatabaseWriter } from '../../../src/db/database_connection';
import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { RecordingMetricsRegistry } from '../../helpers/recording_metrics_registry';

const REFERENCE_NOW = new Date('2026-03-01T10:00:00.000Z');

function build_event(): NewActivityEvent {
  return {
    deposit_request_id: '5f1a2d2c-2d6b-4a3f-9f1e-6f0f1b2c3d4e',
    type: 'deposited_file_received',
    actor: { kind: 'client' },
    access_link_id: null,
    deposited_file_id: null,
    client_ip: null,
    occurred_at: REFERENCE_NOW,
  };
}

describe("Compteur adosse au journal d'activite", () => {
  it("compte l'evenement sous son type des que le journal l'a accepte", async () => {
    const metrics = new RecordingMetricsRegistry();
    const repository = new MeteredActivityEventRepository(
      new FakeActivityEventRepository(),
      metrics,
    );

    await repository.record(build_event());

    expect(metrics.counted_activity_events).toEqual(['deposited_file_received']);
  });

  // Un compteur qui avance sur une ecriture refusee ferait lire une activite
  // qui n'a pas eu lieu — et c'est precisement en incident qu'on le lirait.
  it("ne compte rien quand l'ecriture au journal echoue", async () => {
    const metrics = new RecordingMetricsRegistry();
    const failing_journal: ActivityEventRepository = {
      record: async (): Promise<void> => {
        throw new Error('insertion refusee');
      },
      list_for_deposit_request: async () => [],
      summarize_deposit_requests: async () => new Map(),
      redact_client_ip_recorded_before: async () => 0,
    };

    await expect(
      new MeteredActivityEventRepository(failing_journal, metrics).record(build_event()),
    ).rejects.toThrow('insertion refusee');

    expect(metrics.counted_activity_events).toEqual([]);
  });

  // La transaction de l'appelant doit traverser le decorateur intacte : la
  // perdre ecrirait l'evenement hors de l'action metier, et le journal
  // survivrait a une action annulee.
  it("transmet la transaction de l'appelant au journal sous-jacent", async () => {
    const received_writers: (DatabaseWriter | undefined)[] = [];
    const journal: ActivityEventRepository = {
      record: async (_event: NewActivityEvent, writer?: DatabaseWriter): Promise<void> => {
        received_writers.push(writer);
      },
      list_for_deposit_request: async () => [],
      summarize_deposit_requests: async () => new Map(),
      redact_client_ip_recorded_before: async () => 0,
    };
    const caller_transaction = { marque: 'transaction de l appelant' } as unknown as DatabaseWriter;

    await new MeteredActivityEventRepository(journal, new RecordingMetricsRegistry()).record(
      build_event(),
      caller_transaction,
    );

    expect(received_writers).toEqual([caller_transaction]);
  });

  it('ne compte pas les lectures du journal', async () => {
    const metrics = new RecordingMetricsRegistry();
    const journal = new FakeActivityEventRepository();
    const repository = new MeteredActivityEventRepository(journal, metrics);
    await journal.record(build_event());

    await repository.list_for_deposit_request(build_event().deposit_request_id);
    await repository.summarize_deposit_requests([build_event().deposit_request_id]);
    await repository.redact_client_ip_recorded_before(REFERENCE_NOW);

    expect(metrics.counted_activity_events).toEqual([]);
  });
});
