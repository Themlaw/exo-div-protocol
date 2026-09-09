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

export const access_link_status = deposit_schema.enum('access_link_status', [
  'active',
  'blocked',
  'revoked',
]);

// Le lien est une ENTITE, pas trois colonnes sur la demande : une demande en
// porte plusieurs, successifs, et cet historique EST le journal d'audit. Un
// lien revoque reste donc en base avec sa date et son compteur — c'est ce qui
// permettra de dire a l'avocat que le precedent etait tombe apres dix echecs,
// et quand.
//
// Aucun statut 'expired' : l'expiration se deduit de `expires_at`, comme dans
// `is_access_link_usable`. Un statut a poser par une tache de fond mentirait
// entre deux passages, et la verite se retrouverait a deux endroits.
export const access_link = deposit_schema.table(
  'access_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deposit_request_id: uuid('deposit_request_id')
      .notNull()
      .references(() => deposit_request.id, { onDelete: 'cascade' }),
    // Jamais le token : son HMAC. Une base qui fuite ne doit pas livrer des
    // liens directement utilisables. Voir [[modele-donnees]].
    token_hmac: text('token_hmac').notNull(),
    // Ecrite des maintenant alors que la rotation n'est pas implementee :
    // l'ajouter apres coup obligerait a migrer des lignes dont on ne saurait
    // plus avec quel poivre elles ont ete calculees.
    token_pepper_version: integer('token_pepper_version').notNull(),
    // Hachage lent et sale par lien : on ne retrouve jamais le PIN, on le
    // verifie.
    pin_hash: text('pin_hash').notNull(),
    // La politique est RECOPIEE ici a la creation du lien. La modifier sur la
    // demande ne doit pas atteindre un lien deja en circulation : un client a
    // qui on avait promis dix essais ne peut pas se retrouver bloque a cinq.
    pin_length: integer('pin_length').notNull(),
    max_pin_attempts: integer('max_pin_attempts').notNull(),
    failed_pin_attempts: integer('failed_pin_attempts').notNull().default(0),
    status: access_link_status('status').notNull().default('active'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    blocked_at: timestamp('blocked_at', { withTimezone: true, mode: 'date' }),
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // Un token designe au plus un lien. L'unicite porte sur l'empreinte SEULE,
    // et non sur le couple avec la version de poivre : deux lignes de versions
    // differentes portant la meme empreinte seraient indepartageables a la
    // lecture, alors meme que la requete filtre bien les deux colonnes.
    uniqueIndex('access_link_token_hmac_key').on(table.token_hmac),
    // LA contrainte qui rend « regenerer invalide l'ancien » impossible a
    // rater. Sans elle, un double-clic produit deux liens actifs sur la meme
    // demande : le client se fait bloquer sur l'un pendant que l'autre marche
    // encore, et rien ne le signale.
    uniqueIndex('access_link_one_active_per_request_idx')
      .on(table.deposit_request_id)
      .where(sql`${table.status} = 'active'`),
    // Postgres n'indexe jamais le cote referencant d'une clef etrangere, et
    // c'est le predicat de l'historique des liens d'une demande.
    index('access_link_deposit_request_id_idx').on(table.deposit_request_id, table.created_at),
    // L'invariant que fast-check verifie cote domaine, tenu aussi par le
    // moteur : la validation applicative peut etre contournee par un futur
    // appelant qui ecrirait directement, la contrainte non.
    check(
      'access_link_failed_attempts_within_bounds',
      sql`${table.failed_pin_attempts} BETWEEN 0 AND ${table.max_pin_attempts}`,
    ),
    check(
      'access_link_security_policy_within_bounds',
      sql`${table.max_pin_attempts} BETWEEN ${sql.raw(String(SECURITY_POLICY_BOUNDS.max_pin_attempts.min))} AND ${sql.raw(String(SECURITY_POLICY_BOUNDS.max_pin_attempts.max))}
        AND ${table.pin_length} BETWEEN ${sql.raw(String(SECURITY_POLICY_BOUNDS.pin_length.min))} AND ${sql.raw(String(SECURITY_POLICY_BOUNDS.pin_length.max))}`,
    ),
    check('access_link_expires_after_creation', sql`${table.expires_at} > ${table.created_at}`),
    // L'historique EST le journal : un lien bloque ou revoque sans sa date est
    // un trou dedans, et la question « quand ce lien est-il tombe » n'aurait
    // plus de reponse.
    check(
      'access_link_terminal_status_is_dated',
      sql`(${table.status} <> 'blocked' OR ${table.blocked_at} IS NOT NULL)
        AND (${table.status} <> 'revoked' OR ${table.revoked_at} IS NOT NULL)`,
    ),
  ],
);

// La session est adossee au LIEN, pas a la demande : c'est le lien qui porte
// l'autorisation, et sa revocation doit emporter tout ce qui en decoule. La
// cascade le fait a la suppression ; la relecture du lien a chaque requete le
// fait a la revocation.
export const deposit_session = deposit_schema.table(
  'deposit_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    access_link_id: uuid('access_link_id')
      .notNull()
      .references(() => access_link.id, { onDelete: 'cascade' }),
    // Jamais le jeton : son empreinte. Un jeton de session est un secret
    // porteur au meme titre que le token du lien — qui le lit entre dans le
    // depot sans connaitre le PIN. SHA-256 suffit, sans argon2 : le jeton porte
    // 190 bits d'alea, il n'y a rien a casser hors ligne.
    token_sha256: text('token_sha256').notNull(),
    // Le quota d'autorisations d'ecriture delivrees, porte par la session
    // plutot que deduit d'un comptage de pieces : une piece supprimee puis
    // redeposee rendrait le compteur decroissant, et il suffirait de supprimer
    // pour se refaire un budget. Incremente sous garde par Postgres, donc
    // insensible a deux demandes simultanees.
    issued_upload_count: integer('issued_upload_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('deposit_session_token_sha256_key').on(table.token_sha256),
    check(
      'deposit_session_issued_upload_count_is_not_negative',
      sql`${table.issued_upload_count} >= 0`,
    ),
    // Postgres n'indexe jamais le cote referencant d'une clef etrangere, et la
    // cascade depuis un lien supprime balaierait sinon la table entiere.
    index('deposit_session_access_link_id_idx').on(table.access_link_id),
    check('deposit_session_expires_after_creation', sql`${table.expires_at} > ${table.created_at}`),
  ],
);

export const deposited_file_status = deposit_schema.enum('deposited_file_status', [
  'pending_upload',
  'pending_scan',
  'clean',
  'infected',
  'rejected',
]);

// Rattachee au DOCUMENT ATTENDU et au LIEN qui l'a deposee. Le lien parce que
// c'est lui qui a autorise le depot, et que le journal doit pouvoir dire quel
// porteur a envoye quoi ; le document attendu parce que les pieces appartiennent
// a la demande et survivent a la regeneration d'un lien. Voir
// [[securite-lien-pin]] et [[statuts-et-depot]].
export const deposited_file = deposit_schema.table(
  'deposited_file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expected_document_id: uuid('expected_document_id')
      .notNull()
      .references(() => expected_document.id, { onDelete: 'cascade' }),
    // `cascade` comme le reste, et non `restrict` : la SEULE suppression du
    // produit est celle d'une demande, et elle atteint le lien et les pieces par
    // deux chemins a la fois. Un `restrict` ici ferait dependre le succes de
    // l'ordre dans lequel Postgres deroule les deux cascades. Aucun code ne
    // supprime jamais un lien seul — la revocation est un statut.
    access_link_id: uuid('access_link_id')
      .notNull()
      .references(() => access_link.id, { onDelete: 'cascade' }),
    // Construite par le serveur, jamais par le client. Unique : deux lignes qui
    // designeraient le meme objet feraient qu'une suppression en laisserait une
    // pointer dans le vide.
    object_key: text('object_key').notNull(),
    // Le nom que le client verra, deja nettoye a l'ecriture. Le nom brut n'est
    // stocke nulle part : il n'a aucun usage et serait rendu tel quel le jour
    // ou quelqu'un l'afficherait par megarde.
    display_filename: text('display_filename').notNull(),
    declared_mime_type: text('declared_mime_type').notNull(),
    // Vide tant que la detection n'a pas tourne. C'est LUI qui fait foi face a
    // la liste blanche, le type annonce n'etant que declaratif.
    detected_mime_type: text('detected_mime_type'),
    declared_size_bytes: integer('declared_size_bytes').notNull(),
    actual_size_bytes: integer('actual_size_bytes'),
    status: deposited_file_status('status').notNull().default('pending_upload'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    uploaded_at: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }),
    scanned_at: timestamp('scanned_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('deposited_file_object_key_key').on(table.object_key),
    // UN document attendu, UNE piece : la regle produit du memo produit ici un
    // index unique PARTIEL. Il ne porte que sur les statuts occupants, sinon un
    // upload jamais arrive condamnerait l'emplacement pour toujours. C'est la
    // contrepartie en base de `does_deposited_file_occupy_expected_document` :
    // le controleur refuse, et l'index garantit qu'aucune course ne passe.
    uniqueIndex('deposited_file_one_occupant_per_expected_document_idx')
      .on(table.expected_document_id)
      .where(sql`status IN ('pending_scan', 'clean')`),
    index('deposited_file_access_link_id_idx').on(table.access_link_id),
    // La reconciliation cherche les pieces qui attendent encore un verdict, et
    // elle passera regulierement : sans cet index elle balaierait toute la
    // table a chaque tour.
    index('deposited_file_pending_scan_idx')
      .on(table.uploaded_at)
      .where(sql`status = 'pending_scan'`),
    check('deposited_file_declared_size_is_positive', sql`${table.declared_size_bytes} > 0`),
    check(
      'deposited_file_actual_size_is_positive',
      sql`${table.actual_size_bytes} IS NULL OR ${table.actual_size_bytes} > 0`,
    ),
    // Un objet non arrive n'a pas de date d'arrivee, et tout autre statut en a
    // forcement une : sans cette contrainte, `is_deposited_file_scan_overdue`
    // lirait un `uploaded_at` vide sur une piece bel et bien deposee et ne la
    // declarerait jamais en retard.
    check(
      'deposited_file_uploaded_at_matches_status',
      sql`(${table.status} = 'pending_upload') = (${table.uploaded_at} IS NULL)`,
    ),
    // Seuls `clean` et `infected` sont des verdicts. Dater un `pending_scan`
    // ferait passer pour examine un objet que personne n'a ouvert.
    check(
      'deposited_file_scanned_at_matches_verdict',
      sql`(${table.status} IN ('clean', 'infected')) = (${table.scanned_at} IS NOT NULL)`,
    ),
  ],
);
