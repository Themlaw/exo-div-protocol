import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { MAXIMUM_LAWYER_EMAIL_LENGTH } from '../../shared/lawyer_credentials';

// Schema Postgres dedie : les tables de BetterAuth ne nous appartiennent pas.
// Les isoler rend visible, d'un coup d'oeil sur le nom qualifie, ce qui suit la
// forme imposee par la bibliotheque et ce qui suit nos conventions.
export const auth_schema = pgSchema('auth');

// camelCase assume ici, contrairement au reste du depot : c'est la forme
// attendue par BetterAuth. La remapper en snake_case demanderait une table de
// correspondance a maintenir, que chaque plugin ajoute plus tard reintroduirait
// de toute facon. La frontiere de convention est le schema Postgres lui-meme.
export const auth_user = auth_schema.table('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, (table) => [
  // Meme raisonnement que sur le compteur d'echecs : BetterAuth met l'email en
  // minuscules mais ne le trimme JAMAIS (verifie dans la version installee),
  // donc `demo@x.fr ` et `demo@x.fr` sont deux lignes que la contrainte
  // d'unicite ne rapproche pas. L'unicite serait illusoire.
  check(
    'user_email_is_normalized',
    sql`${table.email} = lower(${table.email})
      AND ${table.email} ~ '^[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+@[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+\\.[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+$'
      AND length(${table.email}) <= ${sql.raw(String(MAXIMUM_LAWYER_EMAIL_LENGTH))}`,
  ),
]);

export const auth_session = auth_schema.table('session', {
  id: text('id').primaryKey(),
  // onDelete cascade : une session qui survivrait a son utilisateur serait un
  // identifiant valide sans titulaire.
  userId: text('userId')
    .notNull()
    .references((): typeof auth_user.id => auth_user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, (table) => [
  // Postgres n'indexe JAMAIS le cote referencant d'une clef etrangere : seul le
  // cote reference a besoin d'un index, et la clef primaire le fournit. Sans
  // celui-ci, lister ou revoquer les sessions d'un avocat parcourt la table
  // entiere, et surtout chaque suppression dans `user` doit la balayer pour
  // appliquer le ON DELETE CASCADE.
  index('session_user_id_idx').on(table.userId),
]);

// Le hachage du mot de passe vit ici, pas sur `user` : BetterAuth traite le
// couple email/mot de passe comme un fournisseur parmi d'autres (providerId
// 'credential'). Toute lecture du hachage passe donc par une jointure
// user -> account.
export const auth_account = auth_schema.table('account', {
  id: text('id').primaryKey(),
  userId: text('userId')
    .notNull()
    .references((): typeof auth_user.id => auth_user.id, { onDelete: 'cascade' }),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  password: text('password'),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt', {
    withTimezone: true,
    mode: 'date',
  }),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', {
    withTimezone: true,
    mode: 'date',
  }),
  scope: text('scope'),
  createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, (table) => [
  // Meme raison que pour `session` : clef etrangere non indexee par defaut.
  index('account_user_id_idx').on(table.userId),
  // Couple par lequel BetterAuth resout un compte lors de la connexion. UNIQUE
  // et non un simple index : sans cela, rien n'interdit deux comptes
  // `credential` pour un meme utilisateur, donc deux hachages de mot de passe
  // valides simultanement — dont un que personne n'a jamais decide.
  uniqueIndex('account_provider_id_account_id_key').on(table.providerId, table.accountId),
]);

export const auth_verification = auth_schema.table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // BetterAuth cherche une verification par son identifiant, jamais par son id.
    index('verification_identifier_idx').on(table.identifier),
  ],
);
