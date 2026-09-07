import { boolean, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

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
});

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
});

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
});

export const auth_verification = auth_schema.table('verification', {
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
});
