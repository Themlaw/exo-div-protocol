import { and, eq, gte, sql, type Column, type SQL } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import {
  authentication_failure_by_ip,
  lawyer_login_failure_by_account,
  lawyer_login_failure_by_account_and_ip,
} from '../db/schema/security_schema';
import {
  LOGIN_FAILURE_DECAY_SECONDS,
  LOGIN_IP_RATE_LIMIT_BOUNDS,
  type LoginThrottleState,
} from './login_throttling';

export const LOGIN_THROTTLE_STORE: unique symbol = Symbol('LOGIN_THROTTLE_STORE');

// L'adresse peut manquer : `resolve_trusted_client_ip` rend `null` quand aucune
// valeur stockable ne peut etre etablie. On ne fabrique alors aucune identite de
// repli — ecrire une valeur brute polluerait le compteur d'un autre client.
export interface LoginThrottleIdentity {
  normalized_email: string;
  client_ip: string | null;
}

export interface LoginThrottleStore {
  read_state(identity: LoginThrottleIdentity, now: Date): Promise<LoginThrottleState>;
  record_failed_attempt(identity: LoginThrottleIdentity, now: Date): Promise<void>;
  // Un coup de sonde refuse n'a evalue aucun mot de passe, mais il doit couter :
  // sans lui le delai resterait fige a sa valeur du premier refus, et pilonner
  // ne serait jamais plus cher. Il n'alimente QUE le compteur (compte, adresse),
  // celui de l'attaquant lui-meme — le nourrir aussi par compte offrirait a
  // l'attaquant le ralentissement de sa victime sans rien tenter.
  record_refused_probe(identity: LoginThrottleIdentity, now: Date): Promise<void>;
  forget_account_failures(identity: LoginThrottleIdentity): Promise<void>;
}

// Une absence de ligne vaut zero echec, et un « jamais echoue » doit se traduire
// par un silence assez long pour que la decroissance ait deja tout efface.
const NEVER_FAILED: Readonly<{ attempts: number; seconds_since_last_failure: number }> = {
  attempts: 0,
  seconds_since_last_failure: Number.POSITIVE_INFINITY,
};

// Une horloge qui recule ne doit pas fabriquer un silence negatif, que
// `decay_consecutive_failed_attempts` interpreterait comme un echec tout frais
// alors qu'il s'agit d'un echec ancien.
function seconds_between(earlier: Date, later: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / 1000);
}

interface StoredFailureCounter {
  consecutive_failed_attempts: number;
  last_failed_at: Date;
}

function describe_stored_counter(
  stored_counter: StoredFailureCounter | undefined,
  now: Date,
): { attempts: number; seconds_since_last_failure: number } {
  if (stored_counter === undefined) {
    return NEVER_FAILED;
  }

  return {
    attempts: stored_counter.consecutive_failed_attempts,
    seconds_since_last_failure: seconds_between(stored_counter.last_failed_at, now),
  };
}

// Toutes les bornes temporelles sont evaluees a partir du `now` recu, jamais du
// `now()` de Postgres : les tests d'integration prouvent la decroissance en
// faisant avancer l'horloge injectee, et une borne evaluee par le serveur
// rendrait cette propriete invérifiable. Deux horloges pour un meme compteur
// auraient de toute facon fini par diverger.
export class DrizzleLoginThrottleStore implements LoginThrottleStore {
  constructor(private readonly database: ApplicationDatabase) {}

  async read_state(identity: LoginThrottleIdentity, now: Date): Promise<LoginThrottleState> {
    const account_counter_rows = await this.database
      .select({
        consecutive_failed_attempts: lawyer_login_failure_by_account.consecutive_failed_attempts,
        last_failed_at: lawyer_login_failure_by_account.last_failed_at,
      })
      .from(lawyer_login_failure_by_account)
      .where(eq(lawyer_login_failure_by_account.email, identity.normalized_email));

    const account = describe_stored_counter(account_counter_rows[0], now);

    // Sans adresse exploitable, les deux couches qui en dependent sont
    // neutralisees plutot que devinees : seule la couche par compte s'applique,
    // et elle ne refuse jamais.
    if (identity.client_ip === null) {
      return {
        account_ip_failed_attempts: 0,
        seconds_since_account_ip_last_failure: Number.POSITIVE_INFINITY,
        account_failed_attempts: account.attempts,
        seconds_since_account_last_failure: account.seconds_since_last_failure,
        ip_failed_attempts_in_window: 0,
      };
    }

    const account_ip_counter_rows = await this.database
      .select({
        consecutive_failed_attempts:
          lawyer_login_failure_by_account_and_ip.consecutive_failed_attempts,
        last_failed_at: lawyer_login_failure_by_account_and_ip.last_failed_at,
      })
      .from(lawyer_login_failure_by_account_and_ip)
      .where(
        and(
          eq(lawyer_login_failure_by_account_and_ip.email, identity.normalized_email),
          eq(lawyer_login_failure_by_account_and_ip.client_ip, identity.client_ip),
        ),
      );

    const window_start: Date = new Date(
      now.getTime() - LOGIN_IP_RATE_LIMIT_BOUNDS.window_seconds * 1000,
    );
    const ip_window_rows = await this.database
      .select({ failure_count: sql<number>`count(*)::int` })
      .from(authentication_failure_by_ip)
      .where(
        and(
          eq(authentication_failure_by_ip.client_ip, identity.client_ip),
          eq(authentication_failure_by_ip.failure_kind, 'lawyer_login'),
          gte(authentication_failure_by_ip.occurred_at, window_start),
        ),
      );

    const account_ip = describe_stored_counter(account_ip_counter_rows[0], now);

    return {
      account_ip_failed_attempts: account_ip.attempts,
      seconds_since_account_ip_last_failure: account_ip.seconds_since_last_failure,
      account_failed_attempts: account.attempts,
      seconds_since_account_last_failure: account.seconds_since_last_failure,
      ip_failed_attempts_in_window: ip_window_rows[0]?.failure_count ?? 0,
    };
  }

  // L'increment est calcule par Postgres a partir de la valeur courante, sous le
  // verrou de la ligne. Un lire-puis-ecrire cote application perdrait des echecs
  // simultanes — exactement ce qu'un attaquant qui parallelise ses tentatives
  // chercherait a provoquer.
  //
  // La decroissance est appliquee ICI et pas seulement a la lecture : sans cela
  // un compteur ancien reprendrait a sa valeur d'avant le silence, et
  // l'escalade de backoff ne redescendrait jamais vraiment.
  async record_failed_attempt(identity: LoginThrottleIdentity, now: Date): Promise<void> {
    await this.database
      .insert(lawyer_login_failure_by_account)
      .values({
        email: identity.normalized_email,
        consecutive_failed_attempts: 1,
        last_failed_at: now,
      })
      .onConflictDoUpdate({
        target: lawyer_login_failure_by_account.email,
        set: {
          consecutive_failed_attempts: next_decayed_attempt_count(
            lawyer_login_failure_by_account.consecutive_failed_attempts,
            lawyer_login_failure_by_account.last_failed_at,
            now,
          ),
          last_failed_at: now,
        },
      });

    if (identity.client_ip === null) {
      return;
    }

    await this.increment_account_and_ip_counter(identity.normalized_email, identity.client_ip, now);

    await this.database.insert(authentication_failure_by_ip).values({
      client_ip: identity.client_ip,
      failure_kind: 'lawyer_login',
      occurred_at: now,
    });
  }

  async record_refused_probe(identity: LoginThrottleIdentity, now: Date): Promise<void> {
    if (identity.client_ip === null) {
      return;
    }

    await this.increment_account_and_ip_counter(identity.normalized_email, identity.client_ip, now);
  }

  private async increment_account_and_ip_counter(
    normalized_email: string,
    client_ip: string,
    now: Date,
  ): Promise<void> {
    await this.database
      .insert(lawyer_login_failure_by_account_and_ip)
      .values({
        email: normalized_email,
        client_ip,
        consecutive_failed_attempts: 1,
        last_failed_at: now,
      })
      .onConflictDoUpdate({
        target: [
          lawyer_login_failure_by_account_and_ip.email,
          lawyer_login_failure_by_account_and_ip.client_ip,
        ],
        set: {
          consecutive_failed_attempts: next_decayed_attempt_count(
            lawyer_login_failure_by_account_and_ip.consecutive_failed_attempts,
            lawyer_login_failure_by_account_and_ip.last_failed_at,
            now,
          ),
          last_failed_at: now,
        },
      });
  }

  // La reussite efface le compteur par compte, et celui du couple (compte,
  // adresse) POUR CETTE SEULE ADRESSE. Effacer le couple pour toutes les
  // adresses offrirait a un attaquant le benefice de la connexion reussie de sa
  // victime. Le compteur par IP, lui, n'est jamais efface : il ne decroit qu'avec
  // le temps, sans quoi un attaquant possedant un compte legitime alternerait
  // tentatives et connexions reussies pour se rendre un budget neuf.
  async forget_account_failures(identity: LoginThrottleIdentity): Promise<void> {
    await this.database
      .delete(lawyer_login_failure_by_account)
      .where(eq(lawyer_login_failure_by_account.email, identity.normalized_email));

    if (identity.client_ip === null) {
      return;
    }

    await this.database
      .delete(lawyer_login_failure_by_account_and_ip)
      .where(
        and(
          eq(lawyer_login_failure_by_account_and_ip.email, identity.normalized_email),
          eq(lawyer_login_failure_by_account_and_ip.client_ip, identity.client_ip),
        ),
      );
  }
}

// Reproduit `decay_consecutive_failed_attempts` en SQL. La duplication est
// assumee : la seule alternative serait de lire la ligne puis de la reecrire,
// ce qui rouvrirait la fenetre de perte d'echecs simultanes que le verrou de
// ligne ferme.
// Les colonnes sont QUALIFIEES par leur table : dans un ON CONFLICT DO UPDATE,
// un nom nu peut designer la ligne existante autant que la pseudo-table
// `excluded`, et Postgres refuse la requete (SQLSTATE 42702). Le compteur
// n'etait alors jamais ecrit, et l'echec passait inapercu — la limitation
// n'existait plus, sans qu'aucune reponse HTTP ne change.
function next_decayed_attempt_count(
  attempts_column: Column,
  last_failure_column: Column,
  now: Date,
): SQL<number> {
  // Serialisee a la main et typee explicitement : hors d'une colonne connue,
  // le pilote ne sait pas quoi faire d'un objet `Date` et refuse le parametre.
  const decay_horizon: Date = new Date(
    now.getTime() - LOGIN_FAILURE_DECAY_SECONDS * 1000,
  );

  return sql<number>`CASE
      WHEN ${last_failure_column} <= ${decay_horizon.toISOString()}::timestamptz
      THEN 1
      ELSE ${attempts_column} + 1
    END`;
}
