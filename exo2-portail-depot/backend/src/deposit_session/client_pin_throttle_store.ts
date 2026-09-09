import { and, eq, gte, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import { authentication_failure_by_ip } from '../db/schema/security_schema';

export const CLIENT_PIN_THROTTLE_STORE: unique symbol = Symbol('CLIENT_PIN_THROTTLE_STORE');

// Memes valeurs que la limitation de la connexion avocat, et constante
// distincte : ce sont deux decisions, qui peuvent diverger le jour ou l'une des
// deux surfaces se revele plus exposee. Volontairement HAUTE dans les deux cas —
// le 443 est en passthrough SNI, donc toutes les requetes risquent de partager
// l'adresse du relais, et une limite serree deviendrait un deni de service
// global declenchable par n'importe qui. La vraie protection du PIN est le
// plafond d'essais PAR LIEN.
export const CLIENT_PIN_IP_RATE_LIMIT_BOUNDS = {
  max_failed_attempts_per_window: 100,
  window_seconds: 900,
} as const;

export interface ClientPinThrottleStore {
  count_recent_failures(client_ip: string, now: Date): Promise<number>;
  record_failure(client_ip: string, now: Date): Promise<void>;
}

// La table est partagee avec la connexion avocat, et c'est le point : une IP qui
// alterne les deux surfaces resterait sous chaque seuil pris separement.
export class DrizzleClientPinThrottleStore implements ClientPinThrottleStore {
  constructor(private readonly database: ApplicationDatabase) {}

  async count_recent_failures(client_ip: string, now: Date): Promise<number> {
    const window_start = new Date(
      now.getTime() - CLIENT_PIN_IP_RATE_LIMIT_BOUNDS.window_seconds * 1000,
    );

    const rows = await this.database
      .select({ failure_count: sql<number>`count(*)::int` })
      .from(authentication_failure_by_ip)
      .where(
        and(
          eq(authentication_failure_by_ip.client_ip, client_ip),
          eq(authentication_failure_by_ip.failure_kind, 'client_pin'),
          gte(authentication_failure_by_ip.occurred_at, window_start),
        ),
      );

    return rows[0]?.failure_count ?? 0;
  }

  // Append-only, comme pour la connexion : deux echecs simultanes depuis la
  // meme adresse ne se marchent pas dessus, la ou un compteur incremente
  // exigerait un verrou de ligne — donc un levier de contention offert.
  async record_failure(client_ip: string, now: Date): Promise<void> {
    await this.database.insert(authentication_failure_by_ip).values({
      client_ip,
      failure_kind: 'client_pin',
      occurred_at: now,
    });
  }
}
