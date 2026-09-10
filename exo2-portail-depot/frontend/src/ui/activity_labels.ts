import type { ActivityActor, ActivityEventType } from '../api/contracts';

// Le journal est LU par l'avocat : il y cherche ce qui s'est mal passe dans son
// dossier, pas le nom interne d'un evenement. Chacun des quinze types a donc sa
// phrase, et un test balaie l'enumeration pour qu'aucun nouveau type n'arrive a
// l'ecran sous sa forme brute.
const ACTIVITY_EVENT_LABELS: Readonly<Record<ActivityEventType, string>> = {
  access_link_issued: 'Lien de depot cree',
  access_link_revoked: 'Lien revoque',
  access_link_blocked: 'Lien bloque apres trop de codes errones',
  unusable_access_link_attempted: 'Tentative sur un lien inutilisable',
  deposit_session_opened: 'Le client a ouvert le lien',
  client_pin_rejected: 'Code refuse',
  deposited_file_received: 'Piece recue',
  deposited_file_removed: 'Piece retiree par le client',
  deposited_file_scanned_clean: 'Piece analysee, saine',
  deposited_file_scanned_infected: 'Piece analysee, mise en quarantaine',
  deposited_file_rejected: 'Piece refusee',
  deposited_file_downloaded: 'Piece telechargee',
  deposit_request_completed_by_client: 'Le client a termine son depot',
  deposit_request_validated: 'Demande validee',
  deposit_request_expired: 'Demande expiree',
};

const ACTIVITY_ACTOR_LABELS: Readonly<Record<ActivityActor['kind'], string>> = {
  lawyer: 'Vous',
  client: 'Le client',
  system: 'Le portail',
};

export function activity_event_label(type: ActivityEventType): string {
  return ACTIVITY_EVENT_LABELS[type];
}

export function activity_actor_label(actor: ActivityActor): string {
  return ACTIVITY_ACTOR_LABELS[actor.kind];
}
