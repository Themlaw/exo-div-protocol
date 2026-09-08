import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { ApplicationDatabase } from './database_connection';

// Le migrator de drizzle-orm ne prend AUCUN verrou : il lit la derniere
// migration appliquee hors transaction, puis applique dans une transaction.
// Deux instances qui demarrent ensemble se croient donc toutes deux seules, et
// comme nos migrations portent un `CREATE SCHEMA "auth"` sans IF NOT EXISTS, la
// perdante plante au demarrage. Un verrou consultatif de session serialise les
// demarrages sans rien couter quand il n'y a qu'une instance.
//
// La valeur n'a pas de sens en soi : c'est un identifiant arbitraire mais fixe,
// que seul ce projet utilise.
export const MIGRATION_ADVISORY_LOCK_KEY = 4_242_601_001;

// Resolu depuis l'emplacement du module et non depuis le repertoire courant :
// en production l'application demarre depuis un repertoire qu'on ne choisit pas.
// `dist/db/` comme `src/db/` remontent tous deux sur `backend/drizzle`.
export function resolve_migrations_folder(): string {
  return resolve(__dirname, '..', '..', 'drizzle');
}

export async function run_database_migrations(
  database: ApplicationDatabase,
): Promise<void> {
  // Verrou consultatif de SESSION et non de transaction : le migrator ouvre sa
  // propre transaction, et un verrou de transaction serait relache a la fin de
  // celle du verrou, donc avant que la migration ait commence.
  await database.execute(sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`);

  try {
    await migrate(database, { migrationsFolder: resolve_migrations_folder() });
  } finally {
    // Dans un `finally` : une migration qui echoue doit rendre le verrou, sinon
    // les autres instances attendent indefiniment un demarrage qui n'aura pas
    // lieu, et le probleme devient un blocage muet au lieu d'une erreur lisible.
    await database.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`);
  }
}
