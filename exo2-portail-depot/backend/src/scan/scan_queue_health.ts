import { sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import type { ScanQueueSnapshot } from '../observability/metrics';

export const SCAN_QUEUE_HEALTH_READER: unique symbol = Symbol('SCAN_QUEUE_HEALTH_READER');

export interface ScanQueueHealthReader {
  // `instant` vient de l'horloge de l'application et non de `now()` cote base :
  // c'est la seule facon pour un test de placer un travail « il y a dix
  // minutes » sans attendre dix minutes.
  read_snapshot(instant: Date): Promise<ScanQueueSnapshot>;
}

interface RawScanQueueSnapshot extends Record<string, unknown> {
  pending_job_count: string;
  running_job_count: string;
  failed_job_count: string;
  oldest_pending_job_age_seconds: string;
}

// Lit la VUE `graphile_worker.jobs`, jamais les tables `_private_*` : la vue
// est la surface que la bibliotheque s'engage a garder, le reste change d'une
// version a l'autre sans prevenir.
//
// Les trois etats sont exclusifs et couvrent volontairement moins que la table :
// un travail programme pour plus tard n'est dans aucun d'eux. Il n'attend pas,
// il patiente — le compter ferait monter l'alerte sur une file qui rejoue
// normalement apres un echec.
export class DrizzleScanQueueHealthReader implements ScanQueueHealthReader {
  constructor(private readonly database: ApplicationDatabase) {}

  async read_snapshot(instant: Date): Promise<ScanQueueSnapshot> {
    // En ISO plutot qu'en `Date` : le pilote ne sait pas typer un parametre de
    // requete brute, la ou le constructeur de requetes lit le type de la
    // colonne. Passer l'objet echoue au liage, pas a la lecture.
    const read_instant = sql`${instant.toISOString()}::timestamptz`;
    const is_pending = sql`locked_at IS NULL AND attempts < max_attempts AND run_at <= ${read_instant}`;

    const rows = await this.database.execute<RawScanQueueSnapshot>(
      sql`SELECT
            count(*) FILTER (WHERE ${is_pending}) AS pending_job_count,
            count(*) FILTER (WHERE locked_at IS NOT NULL AND attempts < max_attempts)
              AS running_job_count,
            count(*) FILTER (WHERE attempts >= max_attempts) AS failed_job_count,
            -- Le PLUS VIEUX, jamais une moyenne : c'est le travail qu'on a
            -- oublie qui dit que la chaine est cassee, pas la file entiere.
            coalesce(
              max(extract(epoch FROM ${read_instant} - run_at)) FILTER (WHERE ${is_pending}),
              0
            ) AS oldest_pending_job_age_seconds
          FROM graphile_worker.jobs`,
    );

    const [row] = rows as unknown as RawScanQueueSnapshot[];

    return {
      pending_job_count: Number(row.pending_job_count),
      running_job_count: Number(row.running_job_count),
      failed_job_count: Number(row.failed_job_count),
      oldest_pending_job_age_seconds: Number(row.oldest_pending_job_age_seconds),
    };
  }
}
