import type { Clock } from '../shared/clock';
import type { RandomSource } from '../domain/presigned_upload';
import { draw_unbiased_secret } from '../shared/random_secret';
import { ACCESS_LINK_TOKEN_ALPHABET } from '../domain/presigned_upload';
import { is_access_link_usable, type AccessLink } from '../domain/access_link';
import {
  verify_client_pin,
  type PinHasher,
  type PinVerificationOutcome,
} from '../domain/verify_client_pin';
import { open_client_deposit_session } from '../domain/deposit_session';
import type { AccessLinkTokenHasher } from '../access_link/access_link_token_hasher';
import type { AccessLinkRepository } from '../access_link/access_link_repository';
import {
  fingerprint_deposit_session_token,
  type DepositSessionRepository,
} from './deposit_session_repository';
import {
  CLIENT_PIN_IP_RATE_LIMIT_BOUNDS,
  type ClientPinThrottleStore,
} from './client_pin_throttle_store';

export const DEPOSIT_LINK_UNLOCKER: unique symbol = Symbol('DEPOSIT_LINK_UNLOCKER');

// Le jeton de session porte la meme entropie que le token du lien : il ouvre le
// depot sans le PIN, il est donc du meme ordre de secret.
export const DEPOSIT_SESSION_TOKEN_LENGTH = 32;

// Trente minutes : le temps de rassembler et deposer quelques pieces. Elle est
// de toute facon BORNEE par l'echeance du lien — la plus courte gagne.
export const CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS = 30 * 60;

// UN SEUL refus pour tout ce qui n'est pas « bloque » : token inconnu, lien
// expire, lien revoque, PIN faux, PIN de mauvaise longueur, PIN demesure, ou
// course perdue sur le compteur. L'appelant rend la meme reponse dans tous ces
// cas — meme statut, meme corps — sans quoi il suffirait de lire la difference
// pour savoir si un token existe.
export type DepositLinkUnlockOutcome =
  | { kind: 'unlocked'; session_token: string; expires_at: Date }
  | { kind: 'refused' }
  | { kind: 'blocked' }
  | { kind: 'rate_limited' };

export interface DepositLinkUnlocker {
  unlock(input: { token: string; submitted_pin: string; client_ip: string | null }): Promise<
    DepositLinkUnlockOutcome
  >;
}

export interface DepositLinkUnlockDependencies {
  access_links: AccessLinkRepository;
  deposit_sessions: DepositSessionRepository;
  token_hasher: AccessLinkTokenHasher;
  pin_hasher: PinHasher;
  throttle_store: ClientPinThrottleStore;
  clock: Clock;
  random_source: RandomSource;
}

export class DepositLinkUnlockService implements DepositLinkUnlocker {
  constructor(private readonly dependencies: DepositLinkUnlockDependencies) {}

  async unlock(input: {
    token: string;
    submitted_pin: string;
    client_ip: string | null;
  }): Promise<DepositLinkUnlockOutcome> {
    const now: Date = this.dependencies.clock.now();

    if (await this.ip_budget_is_exhausted(input.client_ip, now)) {
      return { kind: 'rate_limited' };
    }

    const { token_hmac } = this.dependencies.token_hasher.fingerprint_token(input.token);
    const link: AccessLink | null =
      await this.dependencies.access_links.find_by_token_hmac(token_hmac);

    // Aucun hachage sur un token inconnu, contrairement a la connexion avocat
    // ou le cout uniforme protege l'enumeration des emails : un token de 190
    // bits n'est pas enumerable, et hacher offrirait a un anonyme le droit de
    // bruler les quatre places du portillon avec des tokens inventes.
    //
    // L'echec est quand meme COMPTE par adresse : sans cela, balayer des tokens
    // au hasard serait gratuit.
    if (link === null) {
      await this.record_failure(input.client_ip, now);
      return { kind: 'refused' };
    }

    // Le blocage est le seul etat distingue, et il l'est deja par
    // `GET /public/:token` : le client doit comprendre qu'il lui faut un
    // nouveau lien, pas qu'il a mal recopie son code.
    if (link.status === 'blocked') {
      return { kind: 'blocked' };
    }

    if (!is_access_link_usable(link, now)) {
      await this.record_failure(input.client_ip, now);
      return { kind: 'refused' };
    }

    const outcome: PinVerificationOutcome = await verify_client_pin(
      link,
      input.submitted_pin,
      now,
      { pin_hasher: this.dependencies.pin_hasher },
    );

    const attempt_was_recorded: boolean =
      await this.dependencies.access_links.save_attempt_outcome({
        link_after_attempt: outcome.link_after_attempt,
        expected_failed_pin_attempts: link.failed_pin_attempts,
      });

    // La garde optimiste a refuse l'ecriture : une autre requete est passee
    // entre notre lecture et notre ecriture. On n'accorde rien — accorder sur
    // un etat perime reviendrait a ignorer le plafond que l'autre requete vient
    // peut-etre d'atteindre.
    if (!attempt_was_recorded) {
      await this.record_failure(input.client_ip, now);
      return { kind: 'refused' };
    }

    if (!outcome.granted) {
      await this.record_failure(input.client_ip, now);
      return outcome.link_just_became_blocked ? { kind: 'blocked' } : { kind: 'refused' };
    }

    return this.open_session_for(outcome.link_after_attempt, now);
  }

  private async ip_budget_is_exhausted(client_ip: string | null, now: Date): Promise<boolean> {
    // Sans adresse exploitable — mode degrade du passthrough SNI — la couche par
    // IP ne peut rien affirmer. Elle s'efface, et le plafond PAR LIEN reste :
    // c'est lui qui porte la protection, la limitation par adresse n'etant qu'un
    // garde-fou anti-balayage.
    if (client_ip === null) {
      return false;
    }

    const recent_failures: number = await this.dependencies.throttle_store.count_recent_failures(
      client_ip,
      now,
    );

    return recent_failures >= CLIENT_PIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window;
  }

  private async record_failure(client_ip: string | null, now: Date): Promise<void> {
    if (client_ip === null) {
      return;
    }
    await this.dependencies.throttle_store.record_failure(client_ip, now);
  }

  private async open_session_for(
    link: AccessLink,
    now: Date,
  ): Promise<DepositLinkUnlockOutcome> {
    const session_token: string = draw_unbiased_secret(
      this.dependencies.random_source,
      ACCESS_LINK_TOKEN_ALPHABET,
      DEPOSIT_SESSION_TOKEN_LENGTH,
    );

    const opened = await this.dependencies.deposit_sessions.open_session({
      session: open_client_deposit_session(link, CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS, now),
      token_sha256: fingerprint_deposit_session_token(session_token),
    });

    return { kind: 'unlocked', session_token, expires_at: opened.expires_at };
  }
}
