import { runMigrations } from 'graphile-worker';
import type { ApplicationLogger } from '../shared/logging/application_logger';

export const SCAN_QUEUE_LOG_CONTEXT = 'scan_queue';

// graphile-worker installe ses tables dans SON schema : le notre reste intact,
// et une mise a jour de la bibliotheque ne touche a rien de ce qu'on possede.
export const SCAN_QUEUE_SCHEMA = 'graphile_worker';

// Jouees au demarrage comme les notres, et pour la meme raison : apres
// install.sh personne n'a de terminal a ouvrir. graphile-worker pose son propre
// verrou consultatif, donc deux instances qui demarrent ensemble ne se marchent
// pas dessus.
export async function run_scan_queue_migrations(
  database_url: string,
  logger: ApplicationLogger,
): Promise<void> {
  await runMigrations({ connectionString: database_url, schema: SCAN_QUEUE_SCHEMA });

  logger.info(SCAN_QUEUE_LOG_CONTEXT, 'file de scan prete', { schema: SCAN_QUEUE_SCHEMA });
}
