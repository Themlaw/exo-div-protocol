import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auth_user } from './auth_schema';
import { EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS } from '../../domain/expected_document';
import { SECURITY_POLICY_BOUNDS } from '../../domain/security_policy';

// Schema a nous, distinct de `auth` qui appartient a BetterAuth et de `public`
// laisse a graphile-worker. La frontiere de convention est le schema lui-meme :
// tout ce qui vit ici est en snake_case et nous appartient.
export const deposit_schema = pgSchema('deposit');

export const deposit_request_status = deposit_schema.enum('deposit_request_status', [
  'incomplete',
  'processing',
  'validated',
  'blocked',
  'expired_incomplete',
]);

// La politique de securite est portee par la demande, mais elle sera RECOPIEE
// sur chaque lien a sa creation : la modifier ensuite ne doit pas atteindre un
// lien deja en circulation, sinon un client a qui on avait promis dix essais se
// retrouverait bloque a cinq. Voir [[securite-lien-pin]].
export const deposit_request = deposit_schema.table(
  'deposit_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // L'avocat proprietaire. `text` et non `uuid` : BetterAuth engendre ses
    // identifiants lui-meme, en chaine, et les convertir ferait diverger la
    // clef etrangere de ce que la bibliotheque ecrit.
    owner_user_id: text('owner_user_id')
      .notNull()
      .references(() => auth_user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: deposit_request_status('status').notNull().default('incomplete'),
    max_pin_attempts: integer('max_pin_attempts').notNull(),
    link_lifetime_days: integer('link_lifetime_days').notNull(),
    pin_length: integer('pin_length').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Postgres n'indexe jamais le cote referencant d'une clef etrangere, et
    // c'est aussi le predicat de « Mes demandes » : toute lecture de la liste
    // filtre par proprietaire, et la suppression d'un avocat balaierait sinon
    // la table entiere pour appliquer la cascade.
    index('deposit_request_owner_user_id_idx').on(table.owner_user_id, table.created_at),
    // Les memes bornes que `validate_security_policy`, tenues par le moteur :
    // la validation applicative peut etre contournee par un futur appelant qui
    // ecrirait directement, la contrainte non.
    check(
      'deposit_request_security_policy_within_bounds',
      sql`${table.max_pin_attempts} BETWEEN ${sql.raw(String(SECURITY_POLICY_BOUNDS.max_pin_attempts.min))} AND ${sql.raw(String(SECURITY_POLICY_BOUNDS.max_pin_attempts.max))}
        AND ${table.link_lifetime_days} BETWEEN ${sql.raw(String(SECURITY_POLICY_BOUNDS.link_lifetime_days.min))} AND ${sql.raw(String(SECURITY_POLICY_BOUNDS.link_lifetime_days.max))}
        AND ${table.pin_length} BETWEEN ${sql.raw(String(SECURITY_POLICY_BOUNDS.pin_length.min))} AND ${sql.raw(String(SECURITY_POLICY_BOUNDS.pin_length.max))}`,
    ),
    check('deposit_request_title_is_not_blank', sql`btrim(${table.title}) <> ''`),
  ],
);

// Un document attendu = exactement un emplacement de piece. Le decoupage est
// fait par l'avocat a la creation : c'est ce qui garde « 2 pieces sur 4 »
// lisible et honnete.
export const expected_document = deposit_schema.table(
  'expected_document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deposit_request_id: uuid('deposit_request_id')
      .notNull()
      .references(() => deposit_request.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    position: integer('position').notNull(),
    // Un tableau Postgres plutot qu'une table de jointure : cette liste est
    // toujours lue et ecrite en entier, avec le document qui la porte, et
    // jamais interrogee a l'envers — personne ne cherche « quels documents
    // acceptent le PDF ».
    allowed_mime_types: text('allowed_mime_types').array().notNull(),
    max_size_bytes: integer('max_size_bytes').notNull(),
  },
  (table) => [
    index('expected_document_deposit_request_id_idx').on(table.deposit_request_id),
    // L'ordre d'affichage est une donnee, pas un hasard de tri : deux documents
    // a la meme position rendraient la liste instable d'un chargement a l'autre.
    uniqueIndex('expected_document_position_within_request_idx').on(
      table.deposit_request_id,
      table.position,
    ),
    check('expected_document_label_is_not_blank', sql`btrim(${table.label}) <> ''`),
    check('expected_document_position_is_not_negative', sql`${table.position} >= 0`),
    // Une liste blanche vide n'autorise rien : le document serait impossible a
    // deposer, et l'emplacement resterait vide sans que rien ne l'explique.
    check(
      'expected_document_allowed_mime_types_is_not_empty',
      sql`array_length(${table.allowed_mime_types}, 1) >= 1`,
    ),
    check(
      'expected_document_max_size_within_bounds',
      sql`${table.max_size_bytes} BETWEEN ${sql.raw(String(EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.min))} AND ${sql.raw(String(EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.max))}`,
    ),
  ],
);
