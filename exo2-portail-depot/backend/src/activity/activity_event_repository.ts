import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { ApplicationDatabase, DatabaseWriter } from '../db/database_connection';
import { activity_event } from '../db/schema/deposit_schema';
import type {
  ActivityActor,
  ActivityEvent,
  ActivityEventType,
  DepositRequestActivitySummary,
  NewActivityEvent,
} from '../domain/activity_event';

export const ACTIVITY_EVENT_REPOSITORY: unique symbol = Symbol('ACTIVITY_EVENT_REPOSITORY');

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Le journal se lit par page : une demande active peut porter des centaines
// d'evenements, et le dashboard n'en montre jamais autant.
export const ACTIVITY_PAGE_SIZE = 50;

export interface ActivityEventRepository {
  // `writer` est le point de la methode : passer la transaction de l'action
  // metier fait que l'evenement et l'action tombent ou tiennent ENSEMBLE.
  // L'omettre ecrit hors transaction, ce qui ne convient qu'aux evenements
  // qu'aucune ecriture metier n'accompagne — un telechargement, par exemple.
  record(event: NewActivityEvent, writer?: DatabaseWriter): Promise<void>;

  list_for_deposit_request(
    deposit_request_id: string,
    page_size?: number,
  ): Promise<ActivityEvent[]>;

  // Un seul aller-retour pour toute la liste « Mes demandes » : un resume par
  // demande ferait autant de requetes que de lignes affichees.
  summarize_deposit_requests(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, DepositRequestActivitySummary>>;

  // Rend le nombre de lignes expurgees. UNE instruction et non une lecture
  // suivie d'ecritures : la purge doit converger meme sur une table que
  // personne n'a balayee depuis des mois.
  redact_client_ip_recorded_before(instant: Date): Promise<number>;
}

export class DrizzleActivityEventRepository implements ActivityEventRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  async record(event: NewActivityEvent, writer: DatabaseWriter = this.database): Promise<void> {
    await writer.insert(activity_event).values({
      deposit_request_id: event.deposit_request_id,
      type: event.type,
      actor_kind: event.actor.kind,
      actor_user_id: event.actor.kind === 'lawyer' ? event.actor.user_id : null,
      access_link_id: event.access_link_id,
      deposited_file_id: event.deposited_file_id,
      client_ip: event.client_ip,
      occurred_at: event.occurred_at,
    });
  }

  async list_for_deposit_request(
    deposit_request_id: string,
    page_size: number = ACTIVITY_PAGE_SIZE,
  ): Promise<ActivityEvent[]> {
    if (!UUID_SHAPE.test(deposit_request_id)) {
      return [];
    }

    const rows = await this.database
      .select()
      .from(activity_event)
      .where(eq(activity_event.deposit_request_id, deposit_request_id))
      // Du plus recent au plus ancien, et l'identifiant departage les ex aequo :
      // deux evenements de la meme milliseconde rendraient sinon la page
      // instable d'un chargement a l'autre.
      .orderBy(desc(activity_event.occurred_at), desc(activity_event.id))
      .limit(page_size);

    return rows.map(to_domain_activity_event);
  }

  async summarize_deposit_requests(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, DepositRequestActivitySummary>> {
    if (deposit_request_ids.length === 0) {
      return new Map();
    }

    const rows = await this.database
      .select({
        deposit_request_id: activity_event.deposit_request_id,
        type: activity_event.type,
        event_count: sql<number>`count(*)::int`,
      })
      .from(activity_event)
      .where(
        and(
          inArray(activity_event.deposit_request_id, [...deposit_request_ids]),
          // Seuls les types qui font un probleme : compter les depots reussis
          // ferait relire tout le journal pour une reponse qui les ignore.
          inArray(activity_event.type, [...PROBLEM_ACTIVITY_EVENT_TYPES]),
        ),
      )
      .groupBy(activity_event.deposit_request_id, activity_event.type);

    const summaries = new Map<string, DepositRequestActivitySummary>();

    for (const row of rows) {
      const summary: DepositRequestActivitySummary =
        summaries.get(row.deposit_request_id) ?? build_empty_activity_summary();

      apply_problem_count_to_summary(summary, row.type, row.event_count);
      summaries.set(row.deposit_request_id, summary);
    }

    return summaries;
  }

  async redact_client_ip_recorded_before(instant: Date): Promise<number> {
    const redacted_rows = await this.database
      .update(activity_event)
      .set({ client_ip: null })
      .where(
        and(isNotNull(activity_event.client_ip), lt(activity_event.occurred_at, instant)),
      )
      .returning({ id: activity_event.id });

    return redacted_rows.length;
  }
}

// La meme liste que `has_problem` dans le domaine, dite en termes de requete.
// Les deux doivent rester d'accord : un type ajoute ici sans l'etre la-bas
// ferait un resume qui compte un probleme sans le declarer.
const PROBLEM_ACTIVITY_EVENT_TYPES: readonly ActivityEventType[] = [
  'deposited_file_scanned_infected',
  'deposited_file_rejected',
  'client_pin_rejected',
  'unusable_access_link_attempted',
  'access_link_blocked',
];

export function build_empty_activity_summary(): DepositRequestActivitySummary {
  return {
    has_problem: false,
    infected_count: 0,
    rejected_count: 0,
    rejected_pin_attempt_count: 0,
    unusable_link_attempt_count: 0,
    was_link_blocked: false,
  };
}

function apply_problem_count_to_summary(
  summary: DepositRequestActivitySummary,
  type: ActivityEventType,
  event_count: number,
): void {
  summary.has_problem = true;

  if (type === 'deposited_file_scanned_infected') {
    summary.infected_count = event_count;
  } else if (type === 'deposited_file_rejected') {
    summary.rejected_count = event_count;
  } else if (type === 'client_pin_rejected') {
    summary.rejected_pin_attempt_count = event_count;
  } else if (type === 'unusable_access_link_attempted') {
    summary.unusable_link_attempt_count = event_count;
  } else if (type === 'access_link_blocked') {
    summary.was_link_blocked = true;
  }
}

export function to_domain_activity_event(
  row: typeof activity_event.$inferSelect,
): ActivityEvent {
  return {
    id: row.id,
    deposit_request_id: row.deposit_request_id,
    type: row.type,
    actor: to_domain_activity_actor(row.actor_kind, row.actor_user_id),
    access_link_id: row.access_link_id,
    deposited_file_id: row.deposited_file_id,
    client_ip: row.client_ip,
    occurred_at: row.occurred_at,
  };
}

// La contrainte de base garantit deja l'accord entre la nature et le compte.
// Le `?? ''` n'est donc atteignable que si quelqu'un l'a desactivee : on rend
// alors un acteur avocat sans compte plutot que de lever, parce qu'un journal
// illisible vaut mieux qu'un journal qui refuse de s'ouvrir.
function to_domain_activity_actor(
  actor_kind: 'lawyer' | 'client' | 'system',
  actor_user_id: string | null,
): ActivityActor {
  return actor_kind === 'lawyer' ? { kind: 'lawyer', user_id: actor_user_id ?? '' } : { kind: actor_kind };
}
