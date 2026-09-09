import { randomBytes } from 'node:crypto';
import type { Clock } from '../shared/clock';
import type { RandomSource } from '../domain/presigned_upload';
import { generate_access_link_token } from '../domain/presigned_upload';
import type { PinHasher } from '../domain/verify_client_pin';
import type { SecurityPolicy } from '../domain/security_policy';
import type { AccessLinkRepository } from './access_link_repository';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import { build_activity_event } from '../domain/activity_event';
import type { AccessLinkTokenHasher, AccessLinkTokenFingerprint } from './access_link_token_hasher';
import { compose_access_link_delivery_message } from './access_link_delivery_message';
import { generate_client_pin } from './client_pin_generator';

export const ACCESS_LINK_ISSUER: unique symbol = Symbol('ACCESS_LINK_ISSUER');
export const RANDOM_SOURCE: unique symbol = Symbol('RANDOM_SOURCE');

// Le chemin ouvert par le client, servi par le front — distinct de l'API
// `/api/v1/public/:token` que cette page appellera. Un lien colle dans un mail
// doit ouvrir une page, pas rendre du JSON.
export const CLIENT_DEPOSIT_PATH = '/deposit';

export const SYSTEM_RANDOM_SOURCE: RandomSource = {
  bytes: (length: number): Buffer => randomBytes(length),
};

// LA seule et unique fois ou le token et le PIN existent en clair. Ils vivent le
// temps de composer ce message, et rien ne les stocke : le serveur est
// INCAPABLE de les reafficher, ce n'est pas un choix d'interface.
export interface AccessLinkDelivery {
  url: string;
  pin: string;
  message: string;
  expires_at: Date;
}

export interface AccessLinkIssuer {
  // Rend `null` quand la demande n'appartient pas a cet avocat, exactement
  // comme le depot : le controleur en fait un 404, jamais un 403.
  issue_for_deposit_request(input: {
    deposit_request_id: string;
    owner_user_id: string;
    deposit_request_title: string;
    security_policy: SecurityPolicy;
  }): Promise<AccessLinkDelivery | null>;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AccessLinkIssuanceDependencies {
  access_links: AccessLinkRepository;
  activity_events: ActivityEventRepository;
  token_hasher: AccessLinkTokenHasher;
  pin_hasher: PinHasher;
  clock: Clock;
  random_source: RandomSource;
  public_base_url: string;
}

export class AccessLinkIssuanceService implements AccessLinkIssuer {
  constructor(private readonly dependencies: AccessLinkIssuanceDependencies) {}

  async issue_for_deposit_request(input: {
    deposit_request_id: string;
    owner_user_id: string;
    deposit_request_title: string;
    security_policy: SecurityPolicy;
  }): Promise<AccessLinkDelivery | null> {
    // L'APPARTENANCE D'ABORD, avant de tirer le moindre secret. Emettre coute
    // un hachage argon2 de ~130 ms : le payer avant de savoir si la demande est
    // bien celle de cet avocat reviendrait a offrir ce travail a un compte
    // authentifie qui enverrait des identifiants au hasard, au nom de
    // n'importe qui.
    //
    // Ce controle ne REMPLACE pas celui de l'ecriture : la transaction refait
    // le meme predicat, et c'est elle qui fait foi, seule a l'abri d'une
    // demande transferee entre les deux lectures.
    const requester_owns_the_deposit_request: boolean =
      await this.dependencies.access_links.confirms_deposit_request_ownership(
        input.deposit_request_id,
        input.owner_user_id,
      );

    if (!requester_owns_the_deposit_request) {
      return null;
    }

    const token: string = generate_access_link_token(this.dependencies.random_source);
    const fingerprint: AccessLinkTokenFingerprint =
      this.dependencies.token_hasher.fingerprint_token(token);

    const pin: string = generate_client_pin(
      this.dependencies.random_source,
      input.security_policy.pin_length,
    );
    const pin_hash: string = await this.dependencies.pin_hasher.hash(pin);

    const now: Date = this.dependencies.clock.now();
    const expires_at = new Date(
      now.getTime() + input.security_policy.link_lifetime_days * MILLISECONDS_PER_DAY,
    );

    const issued = await this.dependencies.access_links.issue_link_replacing_current({
      deposit_request_id: input.deposit_request_id,
      owner_user_id: input.owner_user_id,
      issuance: {
        token_hmac: fingerprint.token_hmac,
        token_pepper_version: fingerprint.token_pepper_version,
        pin_hash,
        security_policy: input.security_policy,
        expires_at,
      },
      now,
    });

    // L'ecriture a ete refusee alors que la lecture disait le contraire : la
    // demande a change de mains, ou disparu, entre les deux. Le token et le PIN
    // qu'on venait de tirer n'ont jamais existe pour personne.
    if (issued === null) {
      return null;
    }

    // Une emission INVALIDE le lien precedent : le journal ne porte donc pas de
    // « lien revoque » ici, un lien emis a telle heure dit deja que celui d'avant
    // a cesse d'ouvrir a cet instant. Seule la revocation explicite, qui ne
    // remplace rien, a son propre evenement.
    await this.dependencies.activity_events.record(
      build_activity_event({
        deposit_request_id: input.deposit_request_id,
        type: 'access_link_issued',
        actor: { kind: 'lawyer', user_id: input.owner_user_id },
        access_link_id: issued.id,
        occurred_at: now,
      }),
    );

    const url = `${this.dependencies.public_base_url.replace(/\/+$/, '')}${CLIENT_DEPOSIT_PATH}/${token}`;

    return {
      url,
      pin,
      message: compose_access_link_delivery_message({
        deposit_request_title: input.deposit_request_title,
        url,
        pin,
        expires_at: issued.expires_at,
        max_pin_attempts: issued.max_pin_attempts,
      }),
      expires_at: issued.expires_at,
    };
  }
}
