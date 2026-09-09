import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import { deposit_request, expected_document } from '../db/schema/deposit_schema';
import type { DepositRequestStatus } from '../domain/deposit_request_status';
import type { DepositRequestCreationInput, ExpectedDocument } from '../domain/expected_document';
import type { SecurityPolicy } from '../domain/security_policy';

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
}

export interface DepositRequestDetail {
  id: string;
  title: string;
  status: DepositRequestStatus;
  security_policy: SecurityPolicy;
  created_at: Date;
  expected_documents: ExpectedDocument[];
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
  find_detail_for_owner(
    deposit_request_id: string,
    owner_user_id: string,
  ): Promise<DepositRequestDetail | null>;
}

// Un identifiant qui n'est pas un UUID ne doit pas atteindre Postgres : la
// comparaison leverait « invalid input syntax for type uuid », donc un 500, et
// ce 500 distinguerait cette entree de toutes les autres — un oracle de plus.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DrizzleDepositRequestRepository implements DepositRequestRepository {
  constructor(private readonly database: ApplicationDatabase) {}

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

    const documents_by_request: Map<string, number> = await this.count_expected_documents(
      rows.map((row): string => row.id),
    );

    return rows.map((row): DepositRequestOverview => ({
      ...row,
      expected_document_count: documents_by_request.get(row.id) ?? 0,
      // Ces deux chiffres valent bien zero et null AUJOURD'HUI, et non par
      // defaut : aucune piece ne peut avoir ete deposee ni aucun lien emis,
      // les tables n'existent pas encore. A brancher aux etapes 3 et 5, ou ils
      // deviendront de vraies lectures.
      deposited_document_count: 0,
      link_expires_at: null,
    }));
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
