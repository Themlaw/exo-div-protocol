import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Chemins calcules depuis l'emplacement de ce fichier plutot que depuis le
// repertoire courant : drizzle-kit s'invoque depuis `backend/` alors que sa
// configuration vit dans `tooling/`, et une resolution relative au cwd casserait
// des qu'on l'appelle d'ailleurs.
const backend_root: string = resolve(__dirname, '..');

export default defineConfig({
  dialect: 'postgresql',
  schema: resolve(backend_root, 'src/db/schema/index.ts'),
  out: resolve(backend_root, 'drizzle'),
  // Sans ce filtre, drizzle-kit considererait `public` comme etant sous sa
  // responsabilite et proposerait de supprimer les tables de graphile-worker,
  // qui cree les siennes hors de toute migration.
  schemaFilter: ['auth', 'security'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
