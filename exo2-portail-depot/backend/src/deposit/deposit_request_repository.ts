import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import {
  access_link,
  deposit_request,
  deposited_file,
  expected_document,
} from '../db/schema/deposit_schema';
import type { DepositRequestStatus } from '../domain/deposit_request_status';
import type { DepositRequestCreationInput, ExpectedDocument } from '../domain/expected_document';
import type { SecurityPolicy } from '../domain/security_policy';
import type { DepositedFileRepository } from '../deposited_file/deposited_file_repository';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import type { DepositRequestActivitySummary } from '../domain/activity_event';
import { summarize_deposit_request_activity } from '../domain/activity_event';
import {
  build_lawyer_expected_document_views,
  type LawyerExpectedDocumentView,
} from './lawyer_deposit_views';

export const DEPOSIT_REQUEST_REPOSITORY: unique symbol = Symbol('DEPOSIT_REQUEST_REPOSITORY');

// Ce que la page « Mes demandes » montre d'un coup d'oeil, et rien de plus.
export interface DepositRequestOverview {
  id: string;
  title: string;
  status: DepositRequestStatus;
  expected_document_count: number;
  deposited_document_count: number;
  link_expires_at: Date | null;
  created_at: Date;
  // Le resume tient dans la liste, et c'est le point : l'avocat doit voir d'un
  // coup d'oeil LAQUELLE de ses demandes s'est mal passee, sans ouvrir les
  // douze autres pour s'apercevoir qu'il ne s'y est rien produit.
  activity_summary: DepositRequestActivitySummary;
}

export interface DepositRequestDetail {
  id: string;
  title: string;
  status: DepositRequestStatus;
  security_policy: SecurityPolicy;
  created_at: Date;
  expected_documents: LawyerExpectedDocumentView[];
}

// Ce que le CLIENT voit une fois le PIN passe : le titre, pour qu'il sache quel
// dossier il ouvre, et la liste de ce qu'on lui demande. Ni le proprietaire, ni
// la politique de securite, ni les compteurs d'echecs.
export interface ClientDepositRequestView {
  title: string;
  // Le client a besoin du statut : c'est lui qui dit si une piece peut encore
  // etre retiree. Le lui cacher l'obligerait a decouvrir l'interdiction en la
  // heurtant.
  status: DepositRequestStatus;
  expected_documents: ExpectedDocument[];
}

// Le statut AVANT et APRES : c'est la difference qui dit s'il faut journaliser.
// Rendre le seul statut final obligerait l'appelant a le relire d'abord, donc a
// ouvrir une fenetre entre sa lecture et l'ecriture.
export interface DepositRequestStatusTransition {
  status_before: DepositRequestStatus;
  status_after: DepositRequestStatus;
}

// De quoi decider de la completude, en une seule lecture : les deux nombres
// doivent venir du meme instant, sinon un depot concurrent les rendrait
// incoherents entre eux.
export interface DepositRequestCompletion {
  expected_document_count: number;
  clean_expected_document_count: number;
}

export interface DepositRequestRepository {
  create(input: {
    owner_user_id: string;
    creation: DepositRequestCreationInput;
    security_policy: SecurityPolicy;
  }): Promise<string>;

  // L'appartenance est un PREDICAT DE REQUETE, jamais un test fait apres coup
  // sur une ligne deja lue : une lecture qui rapporte la demande d'un confrere
  // avant de la rejeter est une lecture qui a deja eu lieu, et il suffit d'un
  // futur appelant distrait pour qu'elle sorte.
  list_overviews_for_owner(owner_user_id: string): Promise<DepositRequestOverview[]>;

  // Le predicat seul, sans rapporter la demande : une route qui n'a besoin que
  // de savoir « est-ce son dossier ? » ne doit pas charger les emplacements et
  // les pieces pour en jeter le resultat.
  belongs_to_owner(deposit_request_id: string, owner_user_id: string): Promise<boolean>;
  find_detail_for_owner(
    deposit_request_id: string,
    owner_user_id: string,
  ): Promise<DepositRequestDetail | null>;

  // Sans predicat d'appartenance, et c'est voulu : l'autorisation est portee
  // par la session de depot, qui designe le lien, qui designe la demande.
  // Exiger ici un proprietaire obligerait a en fabriquer un cote client.
  find_client_view(deposit_request_id: string): Promise<ClientDepositRequestView | null>;

  // La decision est PASSEE a la base, elle n'en revient pas : lire le statut
  // puis ecrire le suivant depuis l'appelant laisserait une fenetre ou le
  // worker de scan et une action du client se marcheraient dessus. La ligne est
  // verrouillee le temps que `decide` tranche.
  // `null` : la demande n'existe pas — un verdict peut tomber sur une demande
  // supprimee entre-temps.
  apply_status_transition(
    deposit_request_id: string,
    decide: (current: DepositRequestStatus) => DepositRequestStatus,
  ): Promise<DepositRequestStatusTransition | null>;

  read_completion(deposit_request_id: string): Promise<DepositRequestCompletion>;

  // Les demandes que PLUS PERSONNE ne touche : leur lien est encore actif — donc
  // ni revoque ni bloque — mais son echeance est passee. Le client qui frappe a
  // la porte nous l'apprend tout de suite ; celles-ci n'ont plus personne pour
  // le faire, et c'est le balayage qui les constate.
  list_incomplete_with_expired_link(instant: Date): Promise<string[]>;
}

// Un identifiant qui n'est pas un UUID ne doit pas atteindre Postgres : la
// comparaison leverait « invalid input syntax for type uuid », donc un 500, et
// ce 500 distinguerait cette entree de toutes les autres — un oracle de plus.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DrizzleDepositRequestRepository implements DepositRequestRepository {
  constructor(
    private readonly database: ApplicationDatabase,
    private readonly deposited_files: DepositedFileRepository,
    private readonly activity_events: ActivityEventRepository,
  ) {}

  // Une seule transaction : une demande sans ses documents attendus serait une
  // demande que le client ouvre pour n'y rien trouver a deposer, et rien
  // ensuite ne signalerait qu'elle est incomplete.
  async create(input: {
    owner_user_id: string;
    creation: DepositRequestCreationInput;
    security_policy: SecurityPolicy;
  }): Promise<string> {
    return this.database.transaction(async (transaction): Promise<string> => {
      const created_rows = await transaction
        .insert(deposit_request)
        .values({
          owner_user_id: input.owner_user_id,
          title: input.creation.title.trim(),
          max_pin_attempts: input.security_policy.max_pin_attempts,
          link_lifetime_days: input.security_policy.link_lifetime_days,
          pin_length: input.security_policy.pin_length,
        })
        .returning({ id: deposit_request.id });

      const created_id: string = created_rows[0].id;

      await transaction.insert(expected_document).values(
        input.creation.expected_documents.map((document) => ({
          deposit_request_id: created_id,
          label: document.label.trim(),
          position: document.position,
          allowed_mime_types: document.allowed_mime_types,
          max_size_bytes: document.max_size_bytes,
        })),
      );

      return created_id;
    });
  }

  async list_overviews_for_owner(owner_user_id: string): Promise<DepositRequestOverview[]> {
    const rows = await this.database
      .select({
        id: deposit_request.id,
        title: deposit_request.title,
        status: deposit_request.status,
        created_at: deposit_request.created_at,
      })
      .from(deposit_request)
      .where(eq(deposit_request.owner_user_id, owner_user_id))
      // La plus recente d'abord : sans ordre explicite, Postgres est libre de
      // rendre les lignes dans l'ordre qui l'arrange, et la liste changerait
      // d'un chargement a l'autre.
      .orderBy(desc(deposit_request.created_at));

    const listed_request_ids: string[] = rows.map((row): string => row.id);
    const documents_by_request: Map<string, number> =
      await this.count_expected_documents(listed_request_ids);
    const link_expiry_by_request: Map<string, Date> =
      await this.read_current_link_expiries(listed_request_ids);
    const deposited_by_request: Map<string, number> =
      await this.deposited_files.count_occupied_expected_documents(listed_request_ids);
    // Un seul aller-retour pour toute la liste : un resume par ligne ferait
    // autant de requetes que de demandes affichees.
    const activity_by_request: Map<string, DepositRequestActivitySummary> =
      await this.activity_events.summarize_deposit_requests(listed_request_ids);

    return rows.map((row): DepositRequestOverview => ({
      ...row,
      expected_document_count: documents_by_request.get(row.id) ?? 0,
      // Ne compte que ce qui OCCUPE reellement un emplacement : une reservation
      // dont l'objet n'est jamais arrive ferait croire a l'avocat que le client
      // a depose, et le « 2 pieces sur 4 » cesserait d'etre honnete.
      deposited_document_count: deposited_by_request.get(row.id) ?? 0,
      // `null` veut dire « aucun lien courant » : soit l'avocat n'en a jamais
      // emis, soit le dernier a ete revoque ou bloque. L'echeance rendue peut
      // etre DEJA PASSEE, et c'est voulu — le statut ne dit que ce qu'une
      // decision a pose, l'expiration se lit sur l'horloge.
      link_expires_at: link_expiry_by_request.get(row.id) ?? null,
      // Absente de la carte veut dire « rien ne s'est mal passe » : le resume
      // vide est construit ici plutot que rapporte par une ligne de plus.
      activity_summary: activity_by_request.get(row.id) ?? summarize_deposit_request_activity([]),
    }));
  }

  async belongs_to_owner(deposit_request_id: string, owner_user_id: string): Promise<boolean> {
    if (!UUID_SHAPE.test(deposit_request_id)) {
      return false;
    }

    const rows = await this.database
      .select({ id: deposit_request.id })
      .from(deposit_request)
      .where(
        and(
          eq(deposit_request.id, deposit_request_id),
          eq(deposit_request.owner_user_id, owner_user_id),
        ),
      );

    return rows.length > 0;
  }

  async find_detail_for_owner(
    deposit_request_id: string,
    owner_user_id: string,
  ): Promise<DepositRequestDetail | null> {
    if (!UUID_SHAPE.test(deposit_request_id)) {
      return null;
    }

    const rows = await this.database
      .select()
      .from(deposit_request)
      .where(
        and(
          eq(deposit_request.id, deposit_request_id),
          eq(deposit_request.owner_user_id, owner_user_id),
        ),
      );

    const found = rows[0];
    if (found === undefined) {
      return null;
    }

    const documents = await this.database
      .select()
      .from(expected_document)
      .where(eq(expected_document.deposit_request_id, found.id))
      // La position est une donnee d'affichage : la lire sans l'ordonner
      // reviendrait a ne pas l'avoir stockee.
      .orderBy(asc(expected_document.position));

    return {
      id: found.id,
      title: found.title,
      status: found.status,
      security_policy: {
        max_pin_attempts: found.max_pin_attempts,
        link_lifetime_days: found.link_lifetime_days,
        pin_length: found.pin_length,
      },
      created_at: found.created_at,
      expected_documents: build_lawyer_expected_document_views(
        documents,
        await this.deposited_files.list_for_deposit_request(found.id),
      ),
    };
  }

  // Une transaction, et la ligne VERROUILLEE le temps que l'appelant tranche :
  // le worker de scan et une action du client visent la meme demande, et une
  // lecture suivie d'une ecriture perdrait l'un des deux changements.
  async apply_status_transition(
    deposit_request_id: string,
    decide: (current: DepositRequestStatus) => DepositRequestStatus,
  ): Promise<DepositRequestStatusTransition | null> {
    if (!UUID_SHAPE.test(deposit_request_id)) {
      return null;
    }

    return this.database.transaction(
      async (transaction): Promise<DepositRequestStatusTransition | null> => {
        const locked_rows = await transaction
          .select({ status: deposit_request.status })
          .from(deposit_request)
          .where(eq(deposit_request.id, deposit_request_id))
          .for('update');

        const found = locked_rows[0];
        if (found === undefined) {
          return null;
        }

        const status_before: DepositRequestStatus = found.status;
        const status_after: DepositRequestStatus = decide(status_before);

        // Aucune ecriture quand rien ne change : la reconciliation repasse sur
        // les memes demandes, et une mise a jour par passe reveillerait les
        // declencheurs et le journal de replication pour rien.
        if (status_after !== status_before) {
          await transaction
            .update(deposit_request)
            .set({ status: status_after })
            .where(eq(deposit_request.id, deposit_request_id));
        }

        return { status_before, status_after };
      },
    );
  }

  // Une seule requete pour les deux nombres : les lire separement les prendrait
  // a deux instants differents, et un depot concurrent les rendrait incoherents.
  async read_completion(deposit_request_id: string): Promise<DepositRequestCompletion> {
    if (!UUID_SHAPE.test(deposit_request_id)) {
      return { expected_document_count: 0, clean_expected_document_count: 0 };
    }

    const rows = await this.database
      .select({
        expected_document_count: sql<number>`count(*)::int`,
        clean_expected_document_count: sql<number>`count(${deposited_file}.id)::int`,
      })
      .from(expected_document)
      .leftJoin(
        deposited_file,
        and(
          eq(deposited_file.expected_document_id, expected_document.id),
          eq(deposited_file.status, 'clean'),
        ),
      )
      .where(eq(expected_document.deposit_request_id, deposit_request_id));

    const found = rows[0];
    return found === undefined
      ? { expected_document_count: 0, clean_expected_document_count: 0 }
      : found;
  }

  async list_incomplete_with_expired_link(instant: Date): Promise<string[]> {
    const rows = await this.database
      .selectDistinct({ id: deposit_request.id })
      .from(deposit_request)
      .innerJoin(access_link, eq(access_link.deposit_request_id, deposit_request.id))
      .where(
        and(
          eq(deposit_request.status, 'incomplete'),
          // `active` seulement : un lien revoque est une decision de l'avocat,
          // pas une expiration, et il n'a aucun evenement de cycle de vie.
          eq(access_link.status, 'active'),
          lte(access_link.expires_at, instant),
        ),
      );

    return rows.map((row): string => row.id);
  }

  async find_client_view(deposit_request_id: string): Promise<ClientDepositRequestView | null> {
    const rows = await this.database
      .select({ title: deposit_request.title, status: deposit_request.status })
      .from(deposit_request)
      .where(eq(deposit_request.id, deposit_request_id));

    const found = rows[0];
    if (found === undefined) {
      return null;
    }

    const documents = await this.database
      .select()
      .from(expected_document)
      .where(eq(expected_document.deposit_request_id, deposit_request_id))
      .orderBy(asc(expected_document.position));

    return {
      title: found.title,
      status: found.status,
      expected_documents: documents.map((document): ExpectedDocument => ({
        id: document.id,
        deposit_request_id: document.deposit_request_id,
        label: document.label,
        position: document.position,
        allowed_mime_types: document.allowed_mime_types,
        max_size_bytes: document.max_size_bytes,
      })),
    };
  }

  // Une seule requete pour toute la liste, comme pour les documents : un appel
  // par demande ferait autant d'allers-retours que de lignes affichees.
  //
  // L'index unique partiel garantit qu'il n'existe au plus qu'un lien actif par
  // demande : la Map ne peut donc pas ecraser une echeance par une autre.
  private async read_current_link_expiries(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, Date>> {
    if (deposit_request_ids.length === 0) {
      return new Map();
    }

    const rows = await this.database
      .select({
        deposit_request_id: access_link.deposit_request_id,
        expires_at: access_link.expires_at,
      })
      .from(access_link)
      .where(
        and(
          inArray(access_link.deposit_request_id, [...deposit_request_ids]),
          eq(access_link.status, 'active'),
        ),
      );

    return new Map(rows.map((row): [string, Date] => [row.deposit_request_id, row.expires_at]));
  }

  // Un seul GROUP BY pour toute la liste, et non un COUNT par demande : la page
  // « Mes demandes » ferait sinon une requete par ligne affichee.
  private async count_expected_documents(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, number>> {
    if (deposit_request_ids.length === 0) {
      return new Map();
    }

    const rows = await this.database
      .select({
        deposit_request_id: expected_document.deposit_request_id,
        document_count: sql<number>`count(*)::int`,
      })
      .from(expected_document)
      .where(inArray(expected_document.deposit_request_id, [...deposit_request_ids]))
      .groupBy(expected_document.deposit_request_id);

    return new Map(rows.map((row): [string, number] => [row.deposit_request_id, row.document_count]));
  }
}
