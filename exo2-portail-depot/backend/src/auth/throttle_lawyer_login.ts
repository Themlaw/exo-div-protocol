import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as wait_for } from 'node:timers/promises';
import type { Clock } from '../shared/clock';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import {
  has_lawyer_email_shape,
  is_lawyer_email_too_long,
  normalize_lawyer_email,
} from '../shared/lawyer_credentials';
import { LAWYER_AUTH_ROUTE_PATHS } from './auth_http_contract';
import { LAWYER_AUTH_LOG_CONTEXT } from './lawyer_auth_logging';
import {
  decide_login_throttle,
  resolve_trusted_client_ip,
  type LoginThrottleOutcome,
  type LoginThrottleState,
} from './login_throttling';
import type { LoginThrottleIdentity, LoginThrottleStore } from './login_throttle_store';
import type { LoginConcurrencyAdmission, LoginConcurrencyGate } from './login_concurrency_gate';

// Le ralentissement annonce peut monter a cinq minutes ; le ralentissement
// REELLEMENT applique est plafonne bien plus bas. Dormir cinq minutes cote
// serveur, c'est offrir a l'attaquant cinq minutes de connexion retenue par
// requete : la couche censee le gener deviendrait son levier. Le client honnete,
// lui, lit `Retry-After` et attend le delai complet.
export const MAXIMUM_APPLIED_LOGIN_DELAY_SECONDS = 2;

// Court, et c'est voulu : la file pleine est un pic passager, pas une sanction.
// Un delai long transformerait une pointe de charge en panne pour l'usager
// legitime qui, lui, relit l'en-tete.
export const QUEUE_FULL_RETRY_AFTER_SECONDS = 1;

// Ce qu'on renvoie au client dans tous les cas de refus ou d'entree invalide :
// une reponse qui varierait selon la cause dirait a l'attaquant si le compte
// existe, s'il est ralenti par compte ou par adresse, et ou il en est.
const NEUTRAL_REFUSAL_BODY: string = JSON.stringify({ message: 'Requete refusee' });

export type LoginThrottleDecision =
  | { kind: 'proceed'; applied_delay_seconds: number; announced_delay_seconds: number }
  | { kind: 'refuse'; retry_after_seconds: number };

// La reponse au client annonce le delai complet, mais on n'immobilise nos
// propres ressources que pour une petite fraction de celui-ci.
export function derive_login_throttle_decision(
  outcome: LoginThrottleOutcome,
): LoginThrottleDecision {
  if (outcome.kind === 'refuse') {
    return { kind: 'refuse', retry_after_seconds: outcome.retry_after_seconds };
  }

  if (outcome.kind === 'delay') {
    return {
      kind: 'proceed',
      applied_delay_seconds: Math.min(
        outcome.delay_seconds,
        MAXIMUM_APPLIED_LOGIN_DELAY_SECONDS,
      ),
      announced_delay_seconds: outcome.delay_seconds,
    };
  }

  return { kind: 'proceed', applied_delay_seconds: 0, announced_delay_seconds: 0 };
}

// La chaine `X-Forwarded-For` peut arriver en plusieurs en-tetes autant qu'en
// une seule valeur separee par des virgules : Node ne fusionne pas les deux
// formes. Ne lire que la premiere occurrence laisserait un attaquant rallonger
// la chaine avec un second en-tete et deplacer l'entree que l'on croit fiable.
export function read_forwarded_for_chain(headers: IncomingHttpHeaders): string[] {
  const raw_header: string | string[] | undefined = headers['x-forwarded-for'];
  if (raw_header === undefined) {
    return [];
  }

  const joined_chain: string = Array.isArray(raw_header)
    ? raw_header.join(',')
    : raw_header;

  return joined_chain
    .split(',')
    .map((entry: string): string => entry.trim())
    .filter((entry: string): boolean => entry.length !== 0);
}

export type LoginAttempt =
  // `submitted_body` est reproduit tel quel : c'est lui qu'on repasse a
  // BetterAuth, et n'en garder que l'email perdrait le mot de passe.
  | { kind: 'usable'; normalized_email: string; submitted_body: unknown }
  | { kind: 'unusable' };

// L'email est valide ICI, avant toute entree dans BetterAuth. Deux raisons
// mesurees : un email de 100 000 caracteres declenchait un Argon2 offert a
// l'attaquant, et il faisait ensuite violer le CHECK de la table de compteurs,
// donc l'echec n'etait meme pas compte.
export function read_login_attempt(raw_body: string): LoginAttempt {
  let parsed_body: unknown;
  try {
    parsed_body = JSON.parse(raw_body);
  } catch {
    return { kind: 'unusable' };
  }

  if (typeof parsed_body !== 'object' || parsed_body === null) {
    return { kind: 'unusable' };
  }

  const submitted_email: unknown = (parsed_body as Record<string, unknown>)['email'];
  if (typeof submitted_email !== 'string') {
    return { kind: 'unusable' };
  }

  const normalized_email: string = normalize_lawyer_email(submitted_email);
  if (is_lawyer_email_too_long(normalized_email) || !has_lawyer_email_shape(normalized_email)) {
    return { kind: 'unusable' };
  }

  return { kind: 'usable', normalized_email, submitted_body: parsed_body };
}

async function read_request_body(
  request: IncomingMessage,
  maximum_bytes: number,
): Promise<Buffer | 'too_large'> {
  const received_chunks: Buffer[] = [];
  let received_bytes = 0;

  for await (const chunk of request) {
    const chunk_buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    received_bytes += chunk_buffer.length;
    // Le plafond est verifie a la volee et pas seulement sur `content-length` :
    // une taille annoncee est une declaration du client, pas une garantie.
    if (received_bytes > maximum_bytes) {
      return 'too_large';
    }
    received_chunks.push(chunk_buffer);
  }

  return Buffer.concat(received_chunks);
}

function respond_with_neutral_refusal(
  response: ServerResponse,
  status_code: number,
  retry_after_seconds?: number,
): void {
  response.statusCode = status_code;
  response.setHeader('content-type', 'application/json');
  if (retry_after_seconds !== undefined) {
    response.setHeader('retry-after', String(Math.ceil(retry_after_seconds)));
  }
  response.end(NEUTRAL_REFUSAL_BODY);
}

// Le compteur doit etre a jour AVANT que la reponse ne parte, sans quoi la
// requete suivante du meme attaquant lirait un etat perime — et un attaquant
// qui enchaine sans repit lirait toujours zero. On differe donc la fin de la
// reponse jusqu'a l'ecriture du compteur, plutot que de l'ecrire apres coup.
function end_response_only_after(
  response: ServerResponse,
  finalize: (status_code: number) => Promise<void>,
): void {
  const end_response = response.end.bind(response);
  let already_finalizing = false;

  response.end = function deferred_end(
    ...end_arguments: Parameters<ServerResponse['end']>
  ): ServerResponse {
    if (already_finalizing) {
      return end_response(...end_arguments);
    }
    already_finalizing = true;

    void finalize(response.statusCode).finally((): void => {
      end_response(...end_arguments);
    });

    return response;
  } as ServerResponse['end'];
}

export interface LawyerLoginThrottlingDependencies {
  throttle_store: LoginThrottleStore;
  clock: Clock;
  trusted_proxy_hop_count: number;
  concurrency_gate: LoginConcurrencyGate;
  logger: ApplicationLogger;
  maximum_request_body_bytes: number;
}

export type LawyerLoginThrottler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<'handled' | 'forward_to_lawyer_auth'>;

export function targets_lawyer_login(http_method: string, request_url: string): boolean {
  const path_without_query: string = request_url.split('?')[0] ?? '';
  return (
    http_method.toUpperCase() === 'POST' &&
    path_without_query === LAWYER_AUTH_ROUTE_PATHS.sign_in
  );
}

// Rend `handled` quand la requete a deja recu sa reponse et ne doit surtout pas
// atteindre BetterAuth ; `forward_to_lawyer_auth` quand elle doit poursuivre.
export function build_lawyer_login_throttler(
  dependencies: LawyerLoginThrottlingDependencies,
): LawyerLoginThrottler {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<'handled' | 'forward_to_lawyer_auth'> => {
    const raw_body: Buffer | 'too_large' = await read_request_body(
      request,
      dependencies.maximum_request_body_bytes,
    );
    if (raw_body === 'too_large') {
      respond_with_neutral_refusal(response, 413);
      return 'handled';
    }

    const attempt: LoginAttempt = read_login_attempt(raw_body.toString('utf8'));
    if (attempt.kind === 'unusable') {
      // Aucun compteur touche : la valeur ne tiendrait pas dans la clef, et un
      // compteur alimente par des entrees invalides serait un moyen offert a
      // l'attaquant de faire grossir la table sans jamais tenter un mot de passe.
      respond_with_neutral_refusal(response, 400);
      return 'handled';
    }

    // Le flux est consomme : better-call retombe alors sur `request.body`
    // (verifie dans `better-call/dist/adapters/node/request.mjs`), qu'il
    // re-serialise avant de le passer a BetterAuth.
    (request as IncomingMessage & { body?: unknown }).body = attempt.submitted_body;

    const identity: LoginThrottleIdentity = {
      normalized_email: attempt.normalized_email,
      client_ip: resolve_trusted_client_ip(
        read_forwarded_for_chain(request.headers),
        request.socket.remoteAddress ?? '',
        dependencies.trusted_proxy_hop_count,
      ),
    };

    const now: Date = dependencies.clock.now();
    const state: LoginThrottleState = await dependencies.throttle_store.read_state(identity, now);
    const decision: LoginThrottleDecision = derive_login_throttle_decision(
      decide_login_throttle(state),
    );

    if (decision.kind === 'refuse') {
      dependencies.logger.warn(LAWYER_AUTH_LOG_CONTEXT, 'tentative de connexion refusee', {
        client_ip: identity.client_ip,
        retry_after_seconds: decision.retry_after_seconds,
      });
      // Le coup de sonde est compte avant de repondre : sans quoi la requete
      // suivante lirait le meme compteur, obtiendrait le meme delai, et
      // pilonner ne couterait jamais plus cher qu'au premier refus.
      await dependencies.throttle_store.record_refused_probe(identity, now);
      respond_with_neutral_refusal(response, 429, decision.retry_after_seconds);
      return 'handled';
    }

    if (decision.announced_delay_seconds > 0) {
      response.setHeader('retry-after', String(Math.ceil(decision.announced_delay_seconds)));
      await wait_for(decision.applied_delay_seconds * 1000);
    }

    // La place est prise APRES l'attente : une requete qu'on fait patienter ne
    // doit pas occuper un fil qu'elle n'utilise pas encore.
    const admission: LoginConcurrencyAdmission = await dependencies.concurrency_gate.enter();
    if (admission.kind === 'queue_full') {
      dependencies.logger.warn(
        LAWYER_AUTH_LOG_CONTEXT,
        'connexion refusee : file d attente des evaluations pleine',
        { client_ip: identity.client_ip },
      );
      respond_with_neutral_refusal(response, 503, QUEUE_FULL_RETRY_AFTER_SECONDS);
      return 'handled';
    }

    // Deux declencheurs pour une seule liberation : la fin normale de la
    // reponse, et sa fermeture prematuree par le client. Sans le second, un
    // attaquant qui coupe la connexion apres avoir pris sa place fuirait une
    // place a chaque requete, et le plafond finirait par tout bloquer. Le
    // double appel est sans danger : `release` ne rend sa place qu'une fois.
    response.on('close', admission.release);

    end_response_only_after(response, async (status_code: number): Promise<void> => {
      admission.release();
      try {
        if (status_code >= 200 && status_code < 300) {
          await dependencies.throttle_store.forget_account_failures(identity);
          return;
        }
        await dependencies.throttle_store.record_failed_attempt(
          identity,
          dependencies.clock.now(),
        );
      } catch (error: unknown) {
        // Un compteur qu'on n'a pas su ecrire ne doit pas transformer une
        // reponse deja formee en panne : on journalise et on laisse partir.
        dependencies.logger.error(
          LAWYER_AUTH_LOG_CONTEXT,
          "echec de l'ecriture du compteur de tentatives",
          { error },
        );
      }
    });

    return 'forward_to_lawyer_auth';
  };
}
