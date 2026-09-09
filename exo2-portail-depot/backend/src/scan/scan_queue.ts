import { sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';

export const SCAN_QUEUE: unique symbol = Symbol('SCAN_QUEUE');

// Le nom de la tache, partage entre celui qui enfile et celui qui execute. Une
// chaine ecrite deux fois se serait desynchronisee sans que rien n'echoue :
// le job serait simplement reste en file pour toujours.
export const SCAN_DEPOSITED_FILE_TASK = 'scan_deposited_file';

// Enfilee par l'horloge de graphile-worker et par personne d'autre : la
// reconciliation ne repond a aucun evenement, c'est justement son role.
export const RECONCILE_DEPOSITS_TASK = 'reconcile_deposits';

export interface ScanJobPayload {
  deposited_file_id: string;
}

export interface ScanQueue {
  enqueue_scan(payload: ScanJobPayload): Promise<void>;
}

// Passe par la FONCTION SQL de graphile-worker plutot que par sa bibliotheque
// cliente : l'enfilement partage alors la connexion — et, le jour ou on le
// voudra, la transaction — de l'ecriture metier. Impossible d'enregistrer
// l'arrivee d'un objet sans enfiler son scan, ou l'inverse.
export class GraphileScanQueue implements ScanQueue {
  constructor(private readonly database: ApplicationDatabase) {}

  async enqueue_scan(payload: ScanJobPayload): Promise<void> {
    await this.database.execute(
      sql`SELECT graphile_worker.add_job(
            ${SCAN_DEPOSITED_FILE_TASK},
            payload => ${JSON.stringify(payload)}::json,
            -- La cle d'unicite est la piece elle-meme : deux notifications pour
            -- le meme objet — MinIO reessaie — ne doivent pas produire deux
            -- scans du meme fichier.
            job_key => ${`${SCAN_DEPOSITED_FILE_TASK}:${payload.deposited_file_id}`},
            max_attempts => 5
          )`,
    );
  }
}
