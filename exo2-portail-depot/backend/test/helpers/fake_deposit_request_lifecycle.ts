import type {
  DepositRequestLifecycle,
} from '../../src/deposit/deposit_request_lifecycle';
import type {
  DepositRequestPipelineEvent,
  DepositRequestStatus,
  DepositRequestUserAction,
} from '../../src/domain/deposit_request_status';

export interface RecordedPipelineEvent {
  deposit_request_id: string;
  event: DepositRequestPipelineEvent;
}

export interface RecordedClientAction {
  deposit_request_id: string;
  access_link_id: string;
  action: DepositRequestUserAction;
}

// Enregistre, ne decide rien : la machine a etats a deja ses propres tests, et
// la rejouer ici ferait passer pour une propriete de l'appelant ce qui est une
// propriete du cycle de vie. Ce double ne repond qu'a une question : cet
// appelant a-t-il SIGNALE le fait ?
export class FakeDepositRequestLifecycle implements DepositRequestLifecycle {
  readonly recorded_pipeline_events: RecordedPipelineEvent[] = [];
  readonly clean_notices: string[] = [];
  readonly client_actions: RecordedClientAction[] = [];

  // La forme dont les tests se servent le plus souvent : ce qui a ete signale,
  // dans l'ordre, sans le detail de la demande visee.
  get applied_events(): DepositRequestPipelineEvent[] {
    return this.recorded_pipeline_events.map(
      (recorded: RecordedPipelineEvent): DepositRequestPipelineEvent => recorded.event,
    );
  }

  async apply_pipeline_event(input: {
    deposit_request_id: string;
    event: DepositRequestPipelineEvent;
  }): Promise<DepositRequestStatus | null> {
    this.recorded_pipeline_events.push({ ...input });
    // `null` plutot qu'un statut invente : aucun appelant du pipeline ne lit ce
    // retour, et en fabriquer un laisserait croire qu'il est verifie ici.
    return null;
  }

  async notice_deposited_file_became_clean(
    deposit_request_id: string,
  ): Promise<DepositRequestStatus | null> {
    this.clean_notices.push(deposit_request_id);
    return null;
  }

  async apply_client_action(input: {
    deposit_request_id: string;
    access_link_id: string;
    action: DepositRequestUserAction;
  }): Promise<DepositRequestStatus | null> {
    this.client_actions.push({ ...input });
    return null;
  }
}
