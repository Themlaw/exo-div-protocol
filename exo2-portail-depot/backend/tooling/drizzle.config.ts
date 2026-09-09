import { defineConfig } from 'drizzle-kit';

// Chemins RELATIFS au repertoire courant, qui doit etre `backend/` — c'est ce
// que garantissent les scripts npm `db:generate` et `db:check`. Un chemin
// absolu casse la lecture des instantanes precedents : drizzle-kit prefixe
// `out` par './' pour les retrouver.

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/db/schema/index.ts',
  out: 'drizzle',
  // Sans ce filtre, drizzle-kit considererait `public` comme etant sous sa
  // responsabilite et proposerait de supprimer les tables de graphile-worker,
  // qui cree les siennes hors de toute migration.
  schemaFilter: ['auth', 'security', 'deposit'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
