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

// Une table plutot qu'une cascade de `if` : elle se lit comme la specification
// dont elle sort, et un statut oublie se voit a l'oeil nu. Ce qui n'y figure
// pas est interdit — le defaut est le refus, jamais le passage.
const STATUS_AFTER_USER_ACTION: Readonly<
  Record<DepositRequestUserAction, Partial<Record<DepositRequestStatus, DepositRequestStatus>>>
> = {
  // Le seul point d'entree vers 'processing', et il est EXPLICITE : la bascule
  // ne se declenche pas au dernier envoi, sinon le client qui veut encore
  // remplacer une piece se retrouve bloque par une transition qu'il n'a pas
  // demandee.
  client_finished_deposit: { incomplete: 'processing' },
};

export function apply_deposit_request_user_action(
  current_status: DepositRequestStatus,
  action: DepositRequestUserAction,
): DepositRequestStatus {
  const next_status: DepositRequestStatus | undefined =
    STATUS_AFTER_USER_ACTION[action][current_status];

  // Il y a quelqu'un au bout du fil : lui repondre par une erreur a du sens,
  // c'est un bug d'appel qu'on doit lui signaler. Terminer deux fois un depot,
  // ou le terminer sur un lien bloque, n'est pas une course normale — c'est une
  // interface qui a propose une action qu'elle n'aurait pas du proposer.
  if (next_status === undefined) {
    throw new ForbiddenDepositRequestTransitionError(current_status, action);
  }

  return next_status;
}

// Ce qui n'est pas dans cette table laisse le statut INCHANGE. C'est la
// difference de fond avec l'action utilisateur : personne n'attend de reponse,
// et l'evenement arrive dans un ordre qu'on ne maitrise pas.
const STATUS_AFTER_PIPELINE_EVENT: Readonly<
  Record<DepositRequestPipelineEvent, Partial<Record<DepositRequestStatus, DepositRequestStatus>>>
> = {
  // Depuis 'incomplete', volontairement absent : le scan peut trouver toutes
  // les pieces saines AVANT que le client n'ait clique sur « Terminer le
  // depot ». Valider la demande a sa place lui retirerait le droit de remplacer
  // encore une piece.
  all_expected_documents_clean: { processing: 'validated' },

  // La completude est revocable, et depuis 'validated' aussi : un verdict qui
  // se degrade apres coup doit pouvoir rouvrir la demande, sinon une piece
  // infectee resterait acquise.
  expected_document_became_not_clean: {
    processing: 'incomplete',
    validated: 'incomplete',
  },

  // 'validated' est absent des deux evenements de lien : une demande deja
  // validee ne se degrade pas. Le lien n'est qu'un moyen d'acces, sa fin ne
  // reprend pas un travail acheve.
  access_link_blocked: {
    incomplete: 'blocked',
    processing: 'blocked',
  },

  // 'processing' est absent, et c'est le seul point de cette table qu'aucun
  // test ne fixe : 'expired_incomplete' veut dire « le lien a expire alors que
  // la demande etait INCOMPLETE ». En 'processing' tout est depose et le scan
  // tourne ; l'expiration du lien ne doit pas interrompre un traitement qui va
  // aboutir tout seul.
  access_link_expired: {
    incomplete: 'expired_incomplete',
  },
};

// Totale : ne leve jamais. Un evenement qui ne s'applique pas laisse le statut
// inchange, et l'appelant se contente de le journaliser.
export function apply_deposit_request_pipeline_event(
  current_status: DepositRequestStatus,
  event: DepositRequestPipelineEvent,
): DepositRequestStatus {
  return STATUS_AFTER_PIPELINE_EVENT[event][current_status] ?? current_status;
}
