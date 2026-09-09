import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import { deposit_request, deposited_file, expected_document } from '../db/schema/deposit_schema';
import type { DepositedFile, DepositedFileStatus } from '../domain/deposited_file';

export const DEPOSITED_FILE_REPOSITORY: unique symbol = Symbol('DEPOSITED_FILE_REPOSITORY');

export type NewDepositedFile = Omit<DepositedFile, 'id'>;

// L'emplacement est deja pris. Une exception plutot qu'un `null` : l'appelant
// vient de decider d'ecrire, et confondre « refuse » avec « rien trouve » lui
// ferait rendre un 404 la ou le client doit lire « retirez d'abord la piece ».
export class ExpectedDocumentAlreadyOccupiedError extends Error {
  constructor(readonly expected_document_id: string) {
    super("Cet emplacement porte deja une piece : elle doit etre retiree d'abord");
    this.name = 'ExpectedDocumentAlreadyOccupiedError';
  }
}

// Le SQLSTATE d'une violation d'unicite. Drizzle ENVELOPPE les erreurs du
// pilote : le code vit sur `cause`, jamais a la racine, et une lecture a la
// racine accepterait n'importe quelle erreur.
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const OCCUPANT_INDEX_NAME = 'deposited_file_one_occupant_per_expected_document_idx';

// Les statuts qui occupent un emplacement. L'index unique partiel porte la meme
// liste : la garde applicative et la contrainte de base doivent dire la meme
// chose, sinon l'une des deux ment.
const OCCUPYING_STATUSES: readonly DepositedFileStatus[] = ['pending_scan', 'clean'];

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// La piece ET la demande a laquelle elle appartient. Le second champ n'est pas
// un confort : c'est lui qui permet de verifier que l'URL empruntee designe bien
// le dossier ou la piece vit, et de journaliser sous la bonne demande.
export interface OwnedDepositedFile {
  file: DepositedFile;
  deposit_request_id: string;
}

export interface DepositedFileRepository {
  // L'appartenance est un PREDICAT DE REQUETE : la piece n'est rendue que si
  // elle est bien celle de ce lien-la. Un test fait apres coup sur une ligne
  // deja lue est un test qu'un appelant distrait oubliera.
  find_for_access_link(
    deposited_file_id: string,
    access_link_id: string,
  ): Promise<DepositedFile | null>;

  list_for_deposit_request(deposit_request_id: string): Promise<DepositedFile[]>;

  // L'appartenance de l'AVOCAT, portee jusqu'a la demande par deux jointures.
  // La verifier apres coup sur une ligne deja lue serait un test qu'un appelant
  // distrait oublierait, et l'oubli ouvrirait la piece d'un confrere.
  find_for_owner(
    deposited_file_id: string,
    owner_user_id: string,
  ): Promise<OwnedDepositedFile | null>;

  // La piece qui OCCUPE l'emplacement, s'il y en a une. L'index unique partiel
  // ne peut pas tenir ce role a lui seul : une nouvelle reservation entre en
  // `pending_upload`, statut non occupant, donc elle n'entre pas dans l'index et
  // ne collisionne avec rien. L'index reste le garde de course au moment ou la
  // piece DEVIENT occupante ; le refus, lui, se lit ici.
  find_occupant_of_expected_document(expected_document_id: string): Promise<DepositedFile | null>;

  count_occupied_expected_documents(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, number>>;

  reserve_upload_slot(file: NewDepositedFile): Promise<DepositedFile>;

  // La cle de l'objet est le seul lien entre une notification de MinIO et la
  // piece qu'elle concerne : MinIO ne connait que des cles.
  find_by_object_key(object_key: string): Promise<DepositedFile | null>;

  // Sans predicat d'appartenance : le travailleur de scan n'agit au nom de
  // personne, il execute un job que le serveur a lui-meme enfile.
  find_by_id(deposited_file_id: string): Promise<DepositedFile | null>;

  // Ecrit un etat deja calcule par le domaine. Leve
  // `ExpectedDocumentAlreadyOccupiedError` si l'ecriture ferait deux occupants
  // sur un meme emplacement : c'est l'index qui tranche, comme a la reservation.
  save_state(file: DepositedFile): Promise<void>;

  // Les deux lectures de la RECONCILIATION. Elles ne portent aucun predicat
  // d'appartenance : le balayage ne travaille pour personne, il repare l'etat
  // global. Elles sont bornees par une date plutot que par un nombre, parce
  // qu'un balayage qui laisse un reliquat derriere lui ne converge jamais.
  list_upload_reservations_created_before(instant: Date): Promise<DepositedFile[]>;

  list_scans_pending_since_before(instant: Date): Promise<DepositedFile[]>;

  delete_file(deposited_file_id: string): Promise<void>;
}

export class DrizzleDepositedFileRepository implements DepositedFileRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  async find_for_access_link(
    deposited_file_id: string,
    access_link_id: string,
  ): Promise<DepositedFile | null> {
    // Un identifiant qui n'est pas un UUID ne doit pas atteindre Postgres : la
    // comparaison leverait « invalid input syntax for type uuid », donc un 500,
    // et ce 500 distinguerait cette entree de toutes les autres.
    if (!UUID_SHAPE.test(deposited_file_id)) {
      return null;
    }

    const rows = await this.database
      .select()
      .from(deposited_file)
      .where(
        and(
          eq(deposited_file.id, deposited_file_id),
          eq(deposited_file.access_link_id, access_link_id),
        ),
      );

    const found = rows[0];
    return found === undefined ? null : to_domain_deposited_file(found);
  }

  async find_for_owner(
    deposited_file_id: string,
    owner_user_id: string,
  ): Promise<OwnedDepositedFile | null> {
    if (!UUID_SHAPE.test(deposited_file_id)) {
      return null;
    }

    const rows = await this.database
      .select({
        file: deposited_file,
        deposit_request_id: deposit_request.id,
      })
      .from(deposited_file)
      .innerJoin(expected_document, eq(deposited_file.expected_document_id, expected_document.id))
      .innerJoin(deposit_request, eq(expected_document.deposit_request_id, deposit_request.id))
      .where(
        and(eq(deposited_file.id, deposited_file_id), eq(deposit_request.owner_user_id, owner_user_id)),
      );

    const found = rows[0];
    return found === undefined
      ? null
      : { file: to_domain_deposited_file(found.file), deposit_request_id: found.deposit_request_id };
  }

  async find_by_id(deposited_file_id: string): Promise<DepositedFile | null> {
    if (!UUID_SHAPE.test(deposited_file_id)) {
      return null;
    }

    const rows = await this.database
      .select()
      .from(deposited_file)
      .where(eq(deposited_file.id, deposited_file_id));

    const found = rows[0];
    return found === undefined ? null : to_domain_deposited_file(found);
  }

  async find_by_object_key(object_key: string): Promise<DepositedFile | null> {
    const rows = await this.database
      .select()
      .from(deposited_file)
      .where(eq(deposited_file.object_key, object_key));

    const found = rows[0];
    return found === undefined ? null : to_domain_deposited_file(found);
  }

  async save_state(file: DepositedFile): Promise<void> {
    try {
      await this.database
        .update(deposited_file)
        .set({
          detected_mime_type: file.detected_mime_type,
          actual_size_bytes: file.actual_size_bytes,
          status: file.status,
          uploaded_at: file.uploaded_at,
          scanned_at: file.scanned_at,
        })
        .where(eq(deposited_file.id, file.id));
    } catch (error: unknown) {
      if (violates_occupant_uniqueness(error)) {
        throw new ExpectedDocumentAlreadyOccupiedError(file.expected_document_id);
      }
      throw error;
    }
  }

  async find_occupant_of_expected_document(
    expected_document_id: string,
  ): Promise<DepositedFile | null> {
    const rows = await this.database
      .select()
      .from(deposited_file)
      .where(
        and(
          eq(deposited_file.expected_document_id, expected_document_id),
          inArray(deposited_file.status, [...OCCUPYING_STATUSES]),
        ),
      );

    const found = rows[0];
    return found === undefined ? null : to_domain_deposited_file(found);
  }

  async list_for_deposit_request(deposit_request_id: string): Promise<DepositedFile[]> {
    const rows = await this.database
      .select({ file: deposited_file })
      .from(deposited_file)
      .innerJoin(expected_document, eq(deposited_file.expected_document_id, expected_document.id))
      .where(eq(expected_document.deposit_request_id, deposit_request_id));

    return rows.map((row): DepositedFile => to_domain_deposited_file(row.file));
  }

  // Un seul GROUP BY pour toute la liste « Mes demandes » : un COUNT par
  // demande ferait autant d'allers-retours que de lignes affichees.
  async count_occupied_expected_documents(
    deposit_request_ids: readonly string[],
  ): Promise<Map<string, number>> {
    if (deposit_request_ids.length === 0) {
      return new Map();
    }

    const rows = await this.database
      .select({
        deposit_request_id: expected_document.deposit_request_id,
        occupied_count: sql<number>`count(*)::int`,
      })
      .from(deposited_file)
      .innerJoin(expected_document, eq(deposited_file.expected_document_id, expected_document.id))
      .where(
        and(
          inArray(expected_document.deposit_request_id, [...deposit_request_ids]),
          inArray(deposited_file.status, [...OCCUPYING_STATUSES]),
        ),
      )
      .groupBy(expected_document.deposit_request_id);

    return new Map(
      rows.map((row): [string, number] => [row.deposit_request_id, row.occupied_count]),
    );
  }

  // C'est l'INDEX qui arbitre, pas une lecture prealable : deux demandes de
  // presigned simultanees sur le meme emplacement le liraient toutes deux libre
  // avant que l'une n'ecrive. La course est tranchee par Postgres, et le perdant
  // recoit le meme refus que celui qui aurait lu l'emplacement plein.
  async reserve_upload_slot(file: NewDepositedFile): Promise<DepositedFile> {
    try {
      const inserted_rows = await this.database
        .insert(deposited_file)
        .values({
          expected_document_id: file.expected_document_id,
          access_link_id: file.access_link_id,
          object_key: file.object_key,
          display_filename: file.display_filename,
          declared_mime_type: file.declared_mime_type,
          detected_mime_type: file.detected_mime_type,
          declared_size_bytes: file.declared_size_bytes,
          actual_size_bytes: file.actual_size_bytes,
          status: file.status,
          created_at: file.created_at,
          uploaded_at: file.uploaded_at,
          scanned_at: file.scanned_at,
        })
        .returning();

      return to_domain_deposited_file(inserted_rows[0] as typeof deposited_file.$inferSelect);
    } catch (error: unknown) {
      if (violates_occupant_uniqueness(error)) {
        throw new ExpectedDocumentAlreadyOccupiedError(file.expected_document_id);
      }
      throw error;
    }
  }

  async list_upload_reservations_created_before(instant: Date): Promise<DepositedFile[]> {
    const rows = await this.database
      .select()
      .from(deposited_file)
      .where(
        and(eq(deposited_file.status, 'pending_upload'), lt(deposited_file.created_at, instant)),
      );

    return rows.map(to_domain_deposited_file);
  }

  async list_scans_pending_since_before(instant: Date): Promise<DepositedFile[]> {
    const rows = await this.database
      .select()
      .from(deposited_file)
      .where(and(eq(deposited_file.status, 'pending_scan'), lt(deposited_file.uploaded_at, instant)))
      .orderBy(deposited_file.uploaded_at);

    return rows.map(to_domain_deposited_file);
  }

  // La ligne seulement : l'objet du bucket est supprime par l'appelant, qui seul
  // sait s'il y en avait un. Les enchainer ici ferait qu'une panne de MinIO
  // empecherait de nettoyer la base, ou l'inverse.
  async delete_file(deposited_file_id: string): Promise<void> {
    await this.database.delete(deposited_file).where(eq(deposited_file.id, deposited_file_id));
  }
}

function violates_occupant_uniqueness(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const driver_error: unknown = (error as { cause?: unknown }).cause;
  if (typeof driver_error !== 'object' || driver_error === null) {
    return false;
  }

  const { code, constraint_name } = driver_error as { code?: unknown; constraint_name?: unknown };

  // Le NOM de l'index autant que le code : la table porte deux contraintes
  // d'unicite, et confondre une collision de cle d'objet avec un emplacement
  // occupe ferait repondre « retirez d'abord » sur un defaut de tirage.
  return code === UNIQUE_VIOLATION_SQLSTATE && constraint_name === OCCUPANT_INDEX_NAME;
}

export function to_domain_deposited_file(
  row: typeof deposited_file.$inferSelect,
): DepositedFile {
  return {
    id: row.id,
    expected_document_id: row.expected_document_id,
    access_link_id: row.access_link_id,
    object_key: row.object_key,
    display_filename: row.display_filename,
    declared_mime_type: row.declared_mime_type,
    detected_mime_type: row.detected_mime_type,
    declared_size_bytes: row.declared_size_bytes,
    actual_size_bytes: row.actual_size_bytes,
    status: row.status,
    created_at: row.created_at,
    uploaded_at: row.uploaded_at,
    scanned_at: row.scanned_at,
  };
}
