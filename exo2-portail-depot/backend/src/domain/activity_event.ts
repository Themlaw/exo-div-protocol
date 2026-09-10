// L'enumeration est FERMEE, et le verdict antiviral y occupe trois types
// distincts plutot qu'un type porteur d'une issue : « toutes les pieces
// infectees » doit rester une requete, pas un parcours applicatif.
export const ACTIVITY_EVENT_TYPES = [
  'access_link_issued',
  'access_link_revoked',
  'access_link_blocked',
  // Une tentative sur un lien qui n'ouvre plus : expire, revoque, ou deja
  // bloque. Elle n'est refusee par aucun PIN — le lien est ecarte avant meme la
  // verification — et sans ce type elle ne laisserait aucune trace. C'est
  // pourtant elle qui explique a l'avocat pourquoi son client n'a rien depose.
  'unusable_access_link_attempted',
  'deposit_session_opened',
  'client_pin_rejected',
  'deposited_file_received',
  'deposited_file_removed',
  'deposited_file_scanned_clean',
  'deposited_file_scanned_infected',
  'deposited_file_rejected',
  'deposited_file_downloaded',
  // Les trois seuls changements d'etat qui entrent au journal, et chacun porte
  // un fait qu'aucune autre ligne ne dit. `blocked` et la reouverture apres un
  // verdict degrade en sont volontairement absents : la ligne qui les cause est
  // deja juste au-dessus, au meme instant, et les redire rendrait l'histoire
  // moins lisible, pas plus.
  'deposit_request_completed_by_client',
  'deposit_request_validated',
  'deposit_request_expired',
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

// Trois natures qui ne se confondent jamais. Un `user_id` nullable ferait
// qu'un evenement du client et un evenement du serveur se ressemblent dans la
// base, et un depot finirait par passer pour une action de l'application.
export type ActivityActor =
  | { kind: 'lawyer'; user_id: string }
  // Le client n'a pas d'identifiant : il n'est authentifie par rien d'autre que
  // le lien qu'il porte, et ce lien est deja le sujet de l'evenement.
  | { kind: 'client' }
  | { kind: 'system' };

export interface ActivityEvent {
  id: string;
  deposit_request_id: string;
  type: ActivityEventType;
  actor: ActivityActor;
  // Les SUJETS de l'evenement, pas ses acteurs : un lien revoque par l'avocat
  // porte le lien ici et l'avocat dans `actor`.
  access_link_id: string | null;
  deposited_file_id: string | null;
  client_ip: string | null;
  occurred_at: Date;
}

export type NewActivityEvent = Omit<ActivityEvent, 'id'>;

// Trente jours : c'est la borne des usages pour une donnee de connexion dont on
// n'a pas d'emploi durable. La TRACE METIER, elle, ne s'efface pas avec
// l'adresse — un journal d'audit qui s'auto-detruit ne prouve rien le jour ou
// il faudrait prouver quelque chose.
export const CLIENT_IP_RETENTION_DAYS = 30;

// Les seuls types dont l'adresse apprend quelque chose : ils decrivent tous une
// tentative d'entree. Un depot, un verdict ou un telechargement n'en tirent
// rien, et la conserver serait une donnee personnelle gardee sans usage.
const IP_BEARING_ACTIVITY_EVENT_TYPES: readonly ActivityEventType[] = [
  'client_pin_rejected',
  'access_link_blocked',
  'unusable_access_link_attempted',
  'deposit_session_opened',
];

export function does_activity_event_type_carry_client_ip(type: ActivityEventType): boolean {
  return IP_BEARING_ACTIVITY_EVENT_TYPES.includes(type);
}

export interface ActivityEventDraft {
  deposit_request_id: string;
  type: ActivityEventType;
  actor: ActivityActor;
  access_link_id?: string | null;
  deposited_file_id?: string | null;
  client_ip?: string | null;
  occurred_at: Date;
}

// Le SEUL chemin de creation d'un evenement, et c'est ce qui fait tenir la
// regle : l'adresse est ecartee ici, par une fonction, plutot que confiee a la
// vigilance de chaque appelant. Une consigne se contourne par distraction.
export function build_activity_event(draft: ActivityEventDraft): NewActivityEvent {
  return {
    deposit_request_id: draft.deposit_request_id,
    type: draft.type,
    actor: draft.actor,
    access_link_id: draft.access_link_id ?? null,
    deposited_file_id: draft.deposited_file_id ?? null,
    client_ip: does_activity_event_type_carry_client_ip(draft.type)
      ? (draft.client_ip ?? null)
      : null,
    occurred_at: draft.occurred_at,
  };
}

// Expurge sans supprimer : l'activite reste lisible, la donnee personnelle
// part. Effacer la ligne entiere ferait disparaitre du journal les tentatives
// d'entree, c'est-a-dire exactement ce qu'un audit vient y chercher.
export function redact_activity_event(event: ActivityEvent): ActivityEvent {
  return { ...event, client_ip: null };
}

// Ne dit rien d'un evenement qui ne porte deja plus d'adresse : sans cette
// reponse, la purge periodique reselectionnerait sans fin des lignes qu'elle a
// deja traitees.
export function has_activity_event_client_ip_expired(
  event: ActivityEvent,
  retention_days: number,
  now: Date,
): boolean {
  if (event.client_ip === null) {
    return false;
  }

  const days_since_event: number =
    (now.getTime() - event.occurred_at.getTime()) / (24 * 60 * 60 * 1000);

  return days_since_event > retention_days;
}

export interface DepositRequestActivitySummary {
  has_problem: boolean;
  infected_count: number;
  rejected_count: number;
  rejected_pin_attempt_count: number;
  // Compte a part des PIN refuses : « il s'est trompe de code » et « il est
  // arrive apres l'echeance » n'appellent pas la meme reponse de l'avocat.
  unusable_link_attempt_count: number;
  was_link_blocked: boolean;
}

// Le resume du tableau de bord : assez pour voir qu'il s'est passe quelque
// chose et comprendre quoi, pas assez pour remplacer le journal. Il raconte ce
// qui S'EST PASSE et non l'etat courant — un lien reemis depuis n'efface pas le
// fait que le precedent a ete bloque.
export function summarize_deposit_request_activity(
  events: readonly ActivityEvent[],
): DepositRequestActivitySummary {
  const count_of = (type: ActivityEventType): number =>
    events.filter((event: ActivityEvent): boolean => event.type === type).length;

  const infected_count: number = count_of('deposited_file_scanned_infected');
  // Compte a part de l'infection : l'avocat doit distinguer « votre client a
  // envoye un virus » de « votre client s'est trompe de fichier », les deux
  // n'appelant pas la meme suite.
  const rejected_count: number = count_of('deposited_file_rejected');
  const rejected_pin_attempt_count: number = count_of('client_pin_rejected');
  const unusable_link_attempt_count: number = count_of('unusable_access_link_attempted');
  const was_link_blocked: boolean = count_of('access_link_blocked') > 0;

  return {
    has_problem:
      infected_count > 0 ||
      rejected_count > 0 ||
      rejected_pin_attempt_count > 0 ||
      unusable_link_attempt_count > 0 ||
      was_link_blocked,
    infected_count,
    rejected_count,
    rejected_pin_attempt_count,
    unusable_link_attempt_count,
    was_link_blocked,
  };
}

// Le journal tel qu'il sort de l'application : l'adresse n'y figure PAS. Elle
// reste en base pour l'audit et l'incident, mais rendue a un navigateur elle
// finirait dans une capture d'ecran ou un PDF imprime — deux endroits que la
// purge a trente jours n'atteindra jamais.
export type LawyerActivityEventView = Omit<ActivityEvent, 'deposit_request_id' | 'client_ip'>;

// Une fonction, et non une omission a la main dans le controleur : c'est elle
// que le test epingle, et un champ ajoute demain a `ActivityEvent` ne fuitera
// pas par distraction.
export function to_lawyer_activity_event_view(event: ActivityEvent): LawyerActivityEventView {
  return {
    id: event.id,
    type: event.type,
    actor: event.actor,
    access_link_id: event.access_link_id,
    deposited_file_id: event.deposited_file_id,
    occurred_at: event.occurred_at,
  };
}
