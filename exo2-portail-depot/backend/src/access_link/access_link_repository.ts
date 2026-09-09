import { and, eq, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import { access_link, deposit_request } from '../db/schema/deposit_schema';
import type { AccessLink } from '../domain/access_link';
import type { SecurityPolicy } from '../domain/security_policy';

export const ACCESS_LINK_REPOSITORY: unique symbol = Symbol('ACCESS_LINK_REPOSITORY');

// Ce que le depot recoit pour ecrire un lien : deja des EMPREINTES. Le token et
// le PIN en clair n'entrent jamais dans cette couche — ils vivent le temps de
// composer le message remis a l'avocat, et disparaissent.
export interface AccessLinkIssuance {
  token_hmac: string;
  token_pepper_version: number;
  pin_hash: string;
  security_policy: SecurityPolicy;
  expires_at: Date;
}

export interface AccessLinkRepository {
  // Rend `null` quand la demande n'appartient pas a cet avocat : l'appartenance
  // est un predicat de requete, jamais un controle apres lecture.
  issue_link_replacing_current(input: {
    deposit_request_id: string;
    owner_user_id: string;
    issuance: AccessLinkIssuance;
    now: Date;
  }): Promise<AccessLink | null>;

  find_by_token_hmac(token_hmac: string): Promise<AccessLink | null>;

  // Une lecture BON MARCHE, faite avant de tirer quoi que ce soit : emettre un
  // lien coute un hachage argon2 de ~130 ms, et le payer avant de savoir si
  // l'avocat a le droit de demander offrirait ce travail a qui enverrait des
  // identifiants au hasard. Ce n'est pas la garantie d'appartenance — celle-la
  // reste dans la transaction d'ecriture, seule a l'abri d'une course.
  confirms_deposit_request_ownership(
    deposit_request_id: string,
    owner_user_id: string,
  ): Promise<boolean>;

  // Garde optimiste : l'ecriture n'a lieu que si le compteur est reste celui
  // qu'on avait lu. Rend `false` sinon, sans rien ecrire.
  save_attempt_outcome(input: {
    link_after_attempt: AccessLink;
    expected_failed_pin_attempts: number;
  }): Promise<boolean>;

  revoke_current_link(
    deposit_request_id: string,
    owner_user_id: string,
    now: Date,
  ): Promise<boolean>;
}

type AccessLinkRow = typeof access_link.$inferSelect;

function to_domain_access_link(row: AccessLinkRow): AccessLink {
  return {
    id: row.id,
    deposit_request_id: row.deposit_request_id,
    token_hmac: row.token_hmac,
    token_pepper_version: row.token_pepper_version,
    pin_hash: row.pin_hash,
    pin_length: row.pin_length,
    max_pin_attempts: row.max_pin_attempts,
    failed_pin_attempts: row.failed_pin_attempts,
    status: row.status,
    expires_at: row.expires_at,
    created_at: row.created_at,
    blocked_at: row.blocked_at,
    revoked_at: row.revoked_at,
  };
}

// Un identifiant qui n'est pas un UUID ne doit pas atteindre Postgres : la
// comparaison leverait « invalid input syntax for type uuid », donc un 500, et
// ce 500 distinguerait cette entree de toutes les autres.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DrizzleAccessLinkRepository implements AccessLinkRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  // Revocation et emission dans UNE transaction : entre les deux, l'index
  // unique partiel interdit qu'il existe deux liens actifs. Les faire en deux
  // temps laisserait une fenetre ou la demande n'a plus aucun lien — et, si
  // l'insertion echoue, une demande definitivement sans acces.
  async issue_link_replacing_current(input: {
    deposit_request_id: string;
    owner_user_id: string;
    issuance: AccessLinkIssuance;
    now: Date;
  }): Promise<AccessLink | null> {
    if (!UUID_SHAPE.test(input.deposit_request_id)) {
      return null;
    }

    return this.database.transaction(async (transaction): Promise<AccessLink | null> => {
      const owned_requests = await transaction
        .select({ id: deposit_request.id })
        .from(deposit_request)
        .where(
          and(
            eq(deposit_request.id, input.deposit_request_id),
            eq(deposit_request.owner_user_id, input.owner_user_id),
          ),
        );

      if (owned_requests.length === 0) {
        return null;
      }

      await revoke_active_links(transaction, input.deposit_request_id, input.now);

      const inserted_rows = await transaction
        .insert(access_link)
        .values({
          deposit_request_id: input.deposit_request_id,
          token_hmac: input.issuance.token_hmac,
          token_pepper_version: input.issuance.token_pepper_version,
          pin_hash: input.issuance.pin_hash,
          pin_length: input.issuance.security_policy.pin_length,
          max_pin_attempts: input.issuance.security_policy.max_pin_attempts,
          expires_at: input.issuance.expires_at,
        })
        .returning();

      return to_domain_access_link(inserted_rows[0] as AccessLinkRow);
    });
  }

  async confirms_deposit_request_ownership(
    deposit_request_id: string,
    owner_user_id: string,
  ): Promise<boolean> {
    if (!UUID_SHAPE.test(deposit_request_id)) {
      return false;
    }

    const owned_requests = await this.database
      .select({ id: deposit_request.id })
      .from(deposit_request)
      .where(
        and(
          eq(deposit_request.id, deposit_request_id),
          eq(deposit_request.owner_user_id, owner_user_id),
        ),
      );

    return owned_requests.length === 1;
  }

  async find_by_token_hmac(token_hmac: string): Promise<AccessLink | null> {
    const rows = await this.database
      .select()
      .from(access_link)
      .where(eq(access_link.token_hmac, token_hmac));

    const row: AccessLinkRow | undefined = rows[0];
    return row === undefined ? null : to_domain_access_link(row);
  }

  // Aucun verrou : la verification argon2 dure ~130 ms, et tenir une ligne
  // verrouillee pendant ce temps offrirait a l'attaquant une file de verrous,
  // c'est-a-dire un deni de service donne par la mesure censee l'en proteger.
  // La garde vit donc dans le WHERE, et zero ligne touchee veut dire « une
  // autre requete est passee avant » — la tentative ne compte pas.
  async save_attempt_outcome(input: {
    link_after_attempt: AccessLink;
    expected_failed_pin_attempts: number;
  }): Promise<boolean> {
    const updated_rows = await this.database
      .update(access_link)
      .set({
        failed_pin_attempts: input.link_after_attempt.failed_pin_attempts,
        status: input.link_after_attempt.status,
        blocked_at: input.link_after_attempt.blocked_at,
      })
      .where(
        and(
          eq(access_link.id, input.link_after_attempt.id),
          eq(access_link.failed_pin_attempts, input.expected_failed_pin_attempts),
          eq(access_link.status, 'active'),
        ),
      )
      .returning({ id: access_link.id });

    return updated_rows.length === 1;
  }

  async revoke_current_link(
    deposit_request_id: string,
    owner_user_id: string,
    now: Date,
  ): Promise<boolean> {
    if (!UUID_SHAPE.test(deposit_request_id)) {
      return false;
    }

    const revoked_rows = await this.database
      .update(access_link)
      .set({ status: 'revoked', revoked_at: now })
      .where(
        and(
          eq(access_link.deposit_request_id, deposit_request_id),
          eq(access_link.status, 'active'),
          // La propriete est verifiee DANS la requete, par une sous-requete sur
          // la demande : lire le lien puis comparer laisserait la ligne d'un
          // confrere sortir de la base avant d'etre rejetee.
          sql`EXISTS (
            SELECT 1 FROM ${deposit_request}
            WHERE ${deposit_request.id} = ${access_link.deposit_request_id}
              AND ${deposit_request.owner_user_id} = ${owner_user_id}
          )`,
        ),
      )
      .returning({ id: access_link.id });

    return revoked_rows.length === 1;
  }
}

// Au pluriel bien qu'il ne puisse y en avoir qu'un : c'est l'index unique
// partiel qui le garantit, pas cette requete, et ecrire l'inverse ferait croire
// a une garantie applicative qui n'existe pas.
async function revoke_active_links(
  transaction: Parameters<Parameters<ApplicationDatabase['transaction']>[0]>[0],
  deposit_request_id: string,
  now: Date,
): Promise<void> {
  await transaction
    .update(access_link)
    .set({ status: 'revoked', revoked_at: now })
    .where(
      and(
        eq(access_link.deposit_request_id, deposit_request_id),
        eq(access_link.status, 'active'),
      ),
    );
}
