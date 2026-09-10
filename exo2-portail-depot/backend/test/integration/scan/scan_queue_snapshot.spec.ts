import { sql } from 'drizzle-orm';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import { run_scan_queue_migrations } from '../../../src/scan/scan_queue_migrations';
import { SCAN_DEPOSITED_FILE_TASK } from '../../../src/scan/scan_queue';
import {
  DrizzleScanQueueHealthReader,
  type ScanQueueHealthReader,
} from '../../../src/scan/scan_queue_health';
import type { ScanQueueSnapshot } from '../../../src/observability/metrics';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import type { ApplicationLogger } from '../../../src/shared/logging/application_logger';

const REFERENCE_NOW = new Date('2026-04-01T12:00:00.000Z');

function silent_logger(): ApplicationLogger {
  const ignore = (): void => undefined;
  return { debug: ignore, info: ignore, warn: ignore, error: ignore };
}

function seconds_before(instant: Date, seconds: number): Date {
  return new Date(instant.getTime() - seconds * 1000);
}

describe('Instantane de la file de scan', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let database: ApplicationDatabase;
  let reader: ScanQueueHealthReader;

  beforeAll(async () => {
    await run_scan_queue_migrations(
      process.env[ENVIRONMENT_VARIABLE_NAMES.database_url] as string,
      silent_logger(),
    );

    integration_test_application = await create_integration_test_application();
    database = integration_test_application.app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    reader = new DrizzleScanQueueHealthReader(database);
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  beforeEach(async () => {
    // La file est un etat GLOBAL du schema : un job laisse par le test
    // precedent compterait dans l'instantane du suivant, et l'echec accuserait
    // la requete plutot que le voisin.
    await database.execute(sql`DELETE FROM graphile_worker._private_jobs`);
  });

  // `add_job` d'abord, puis retouche de la ligne : c'est la seule facon
  // d'obtenir un job verrouille ou a bout d'essais sans faire tourner un vrai
  // travailleur. La table interne est touchee ICI et nulle part dans `src/`,
  // ou seule la vue publique `graphile_worker.jobs` est lue.
  async function enqueue_job(
    key: string,
    shape: {
      run_at?: Date;
      locked_at?: Date | null;
      attempts?: number;
      max_attempts?: number;
    } = {},
  ): Promise<void> {
    await database.execute(
      sql`SELECT graphile_worker.add_job(
            ${SCAN_DEPOSITED_FILE_TASK},
            payload => ${JSON.stringify({ deposited_file_id: key })}::json,
            job_key => ${key},
            max_attempts => ${shape.max_attempts ?? 5}
          )`,
    );

    await database.execute(
      sql`UPDATE graphile_worker._private_jobs
          SET run_at = ${(shape.run_at ?? REFERENCE_NOW).toISOString()}::timestamptz,
              locked_at = ${shape.locked_at?.toISOString() ?? null}::timestamptz,
              attempts = ${shape.attempts ?? 0}
          WHERE key = ${key}`,
    );
  }

  it('rend zero partout sur une file vide', async () => {
    const snapshot: ScanQueueSnapshot = await reader.read_snapshot(REFERENCE_NOW);

    expect(snapshot).toEqual({
      pending_job_count: 0,
      running_job_count: 0,
      failed_job_count: 0,
      oldest_pending_job_age_seconds: 0,
    });
  });

  it('compte en attente un job enfile et jamais pris', async () => {
    await enqueue_job('job-en-attente', { run_at: seconds_before(REFERENCE_NOW, 30) });

    const snapshot: ScanQueueSnapshot = await reader.read_snapshot(REFERENCE_NOW);

    expect(snapshot.pending_job_count).toBe(1);
    expect(snapshot.running_job_count).toBe(0);
    expect(snapshot.failed_job_count).toBe(0);
  });

  // L'age retenu est celui du PLUS VIEUX, jamais une moyenne : c'est le job
  // qu'on a oublie qui dit que la chaine est cassee, pas la file dans son
  // ensemble.
  it('retient l age du plus vieux job en attente', async () => {
    await enqueue_job('job-recent', { run_at: seconds_before(REFERENCE_NOW, 10) });
    await enqueue_job('job-ancien', { run_at: seconds_before(REFERENCE_NOW, 600) });

    const snapshot: ScanQueueSnapshot = await reader.read_snapshot(REFERENCE_NOW);

    expect(snapshot.pending_job_count).toBe(2);
    expect(snapshot.oldest_pending_job_age_seconds).toBe(600);
  });

  it('compte en cours un job verrouille par un travailleur, et non en attente', async () => {
    await enqueue_job('job-verrouille', {
      run_at: seconds_before(REFERENCE_NOW, 60),
      locked_at: seconds_before(REFERENCE_NOW, 5),
    });

    const snapshot: ScanQueueSnapshot = await reader.read_snapshot(REFERENCE_NOW);

    expect(snapshot.running_job_count).toBe(1);
    expect(snapshot.pending_job_count).toBe(0);
    // Un job en cours de scan n'attend plus : le compter dans l'age ferait
    // monter l'alerte pendant que la chaine travaille normalement.
    expect(snapshot.oldest_pending_job_age_seconds).toBe(0);
  });

  it('compte en echec un job qui a epuise ses essais, et non en attente', async () => {
    await enqueue_job('job-epuise', {
      run_at: seconds_before(REFERENCE_NOW, 900),
      attempts: 5,
      max_attempts: 5,
    });

    const snapshot: ScanQueueSnapshot = await reader.read_snapshot(REFERENCE_NOW);

    expect(snapshot.failed_job_count).toBe(1);
    expect(snapshot.pending_job_count).toBe(0);
    expect(snapshot.oldest_pending_job_age_seconds).toBe(0);
  });

  // Un job replanifie apres echec attend depuis son `run_at`, pas depuis sa
  // creation. Mesurer depuis la creation ferait hurler l'alerte sur une file
  // qui rejoue normalement.
  it('ignore un job programme pour plus tard', async () => {
    await enqueue_job('job-a-venir', {
      run_at: new Date(REFERENCE_NOW.getTime() + 300 * 1000),
    });

    const snapshot: ScanQueueSnapshot = await reader.read_snapshot(REFERENCE_NOW);

    expect(snapshot.pending_job_count).toBe(0);
    expect(snapshot.oldest_pending_job_age_seconds).toBe(0);
  });
});
