import { and, eq, lt, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { ApplicationDatabase } from '../db/database_connection';
import { access_link, deposit_session } from '../db/schema/deposit_schema';
import type { AccessLink } from '../domain/access_link';
import type { DepositSession, NewDepositSession } from '../domain/deposit_session';
import { to_domain_access_link } from '../access_link/access_link_repository';

export const DEPOSIT_SESSION_REPOSITORY: unique symbol = Symbol('DEPOSIT_SESSION_REPOSITORY');

// SHA-256 nu, sans argon2 et sans poivre : le jeton porte 190 bits d'alea tires
// par le serveur, il n'y a rien a casser hors ligne ni a deviner. Le hachage
// sert a ce qu'une base qui fuite ne livre aucune session ouverte — pas a
// ralentir une attaque par dictionnaire, qui n'aurait aucun sens ici.
export function fingerprint_deposit_session_token(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Le lien accompagne TOUJOURS la session, et dans la meme lecture : son etat est
// relu a chaque requete, sinon une revocation par l'avocat n'aurait d'effet
// qu'a l'expiration de la session. Les rendre separement laisserait un appelant
// oublier le second.
export interface OpenedDepositSession {
  session: DepositSession;
  access_link: AccessLink;
}

export interface DepositSessionRepository {
  open_session(input: { session: NewDepositSession; token_sha256: string }): Promise<DepositSession>;

  find_by_token_fingerprint(token_sha256: string): Promise<OpenedDepositSession | null>;

  // Incremente et rend `false` si le plafond est deja atteint, EN UNE SEULE
  // ecriture gardee : lire puis ecrire laisserait deux demandes simultanees
  // franchir ensemble le dernier cran. Rend `false` aussi pour une session
  // inconnue, ce qui est le bon refus.
  consume_upload_allowance(deposit_session_id: string, maximum_allowed: number): Promise<boolean>;
}

export class DrizzleDepositSessionRepository implements DepositSessionRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  async consume_upload_allowance(
    deposit_session_id: string,
    maximum_allowed: number,
  ): Promise<boolean> {
    const updated_rows = await this.database
      .update(deposit_session)
      .set({ issued_upload_count: sql`${deposit_session.issued_upload_count} + 1` })
      .where(
        and(
          eq(deposit_session.id, deposit_session_id),
          lt(deposit_session.issued_upload_count, maximum_allowed),
        ),
      )
      .returning({ id: deposit_session.id });

    return updated_rows.length > 0;
  }

  async open_session(input: {
    session: NewDepositSession;
    token_sha256: string;
  }): Promise<DepositSession> {
    const inserted_rows = await this.database
      .insert(deposit_session)
      .values({
        access_link_id: input.session.access_link_id,
        token_sha256: input.token_sha256,
        created_at: input.session.created_at,
        expires_at: input.session.expires_at,
      })
      .returning();

    const row = inserted_rows[0] as typeof deposit_session.$inferSelect;
    return {
      id: row.id,
      access_link_id: row.access_link_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }

  async find_by_token_fingerprint(token_sha256: string): Promise<OpenedDepositSession | null> {
    const rows = await this.database
      .select()
      .from(deposit_session)
      .innerJoin(access_link, eq(deposit_session.access_link_id, access_link.id))
      .where(eq(deposit_session.token_sha256, token_sha256));

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      session: {
        id: row.deposit_session.id,
        access_link_id: row.deposit_session.access_link_id,
        created_at: row.deposit_session.created_at,
        expires_at: row.deposit_session.expires_at,
      },
      access_link: to_domain_access_link(row.access_link),
    };
  }
}
