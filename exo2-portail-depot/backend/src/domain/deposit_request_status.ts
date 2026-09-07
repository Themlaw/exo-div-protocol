import { NotImplementedError } from './not_implemented';

// Vocabulaire cote avocat. Le client, lui, voit seulement "tout est depose ou non".
export type DepositRequestStatus =
  | 'incomplete'
  | 'processing'
  | 'validated'
  | 'blocked'
  | 'expired_incomplete';

// Le decoupage ne suit pas synchrone/asynchrone mais "quelqu'un attend-il une reponse".
// Une action utilisateur a un interlocuteur : lui repondre par une erreur a du sens.
export type DepositRequestUserAction = 'client_finished_deposit';

// Un evenement de pipeline n'a personne au bout du fil. Il arrive quand il arrive,
// et souvent dans un ordre qu'on ne controle pas : un verdict de scan peut tomber
// trois secondes apres le blocage du lien. Le faire lever ferait planter le worker
// sur un chemin parfaitement normal.
export type DepositRequestPipelineEvent =
  | 'all_expected_documents_clean'
  | 'expected_document_became_not_clean'
  | 'access_link_blocked'
  | 'access_link_expired';

export class ForbiddenDepositRequestTransitionError extends Error {
  constructor(
    readonly current_status: DepositRequestStatus,
    readonly action: DepositRequestUserAction,
  ) {
    super(`Transition interdite : ${current_status} + ${action}`);
    this.name = 'ForbiddenDepositRequestTransitionError';
  }
}

export function apply_deposit_request_user_action(
  _current_status: DepositRequestStatus,
  _action: DepositRequestUserAction,
): DepositRequestStatus {
  throw new NotImplementedError('apply_deposit_request_user_action');
}

// Totale : ne leve jamais. Un evenement qui ne s'applique pas laisse le statut
// inchange, et l'appelant se contente de le journaliser.
export function apply_deposit_request_pipeline_event(
  _current_status: DepositRequestStatus,
  _event: DepositRequestPipelineEvent,
): DepositRequestStatus {
  throw new NotImplementedError('apply_deposit_request_pipeline_event');
}
