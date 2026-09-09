import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import {
  read_own_route_access_kinds,
  resolve_route_access_kind,
  type RouteAccessKind,
} from '../auth/route_access';
import { DEPOSIT_SESSION_COOKIE_NAME } from '../auth/auth_http_contract';
import {
  ACCESS_LINK_TOKEN_HASHER,
  type AccessLinkTokenHasher,
} from '../access_link/access_link_token_hasher';
import { CLOCK, type Clock } from '../shared/clock';
import { is_deposit_session_usable } from '../domain/deposit_session';
import {
  DEPOSIT_SESSION_REPOSITORY,
  fingerprint_deposit_session_token,
  type DepositSessionRepository,
  type OpenedDepositSession,
} from './deposit_session_repository';

const AUTHENTICATED_DEPOSIT_SESSION_KEY = Symbol('authenticated_deposit_session');

type RequestCarryingDepositSession = IncomingMessage & {
  [AUTHENTICATED_DEPOSIT_SESSION_KEY]?: OpenedDepositSession;
};

export function read_authenticated_deposit_session(
  request: IncomingMessage,
): OpenedDepositSession | null {
  return (request as RequestCarryingDepositSession)[AUTHENTICATED_DEPOSIT_SESSION_KEY] ?? null;
}

// Enregistre en APP_GUARD comme le garde avocat, et pour la meme raison : une
// route `client_session` ajoutee demain est verifiee sans que son auteur ait a
// s'en souvenir. Le garde avocat, lui, laisse passer tout ce qui n'est pas
// 'lawyer' — chacun ne connait qu'un mecanisme.
@Injectable()
export class ClientDepositSessionGuard implements CanActivate {
  constructor(
    @Inject(DEPOSIT_SESSION_REPOSITORY)
    private readonly deposit_sessions: DepositSessionRepository,
    @Inject(ACCESS_LINK_TOKEN_HASHER) private readonly token_hasher: AccessLinkTokenHasher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access_kind: RouteAccessKind = resolve_route_access_kind(
      read_own_route_access_kinds([context.getClass(), context.getHandler()]),
    );

    if (access_kind !== 'client_session') {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      IncomingMessage & { params?: Record<string, string> }
    >();
    const opened_session: OpenedDepositSession | null = await this.resolve_session_for(
      request.headers,
      request.params?.token ?? '',
    );

    // Un refus unique, comme sur le deverrouillage : cookie absent, session
    // inconnue, session expiree, lien revoque, ou session presentee sur un
    // autre lien que le sien. Les distinguer dirait a qui essaie lequel de ces
    // etats il vient de toucher.
    if (opened_session === null) {
      throw new UnauthorizedException();
    }

    (request as RequestCarryingDepositSession)[AUTHENTICATED_DEPOSIT_SESSION_KEY] = opened_session;
    return true;
  }

  private async resolve_session_for(
    headers: IncomingHttpHeaders,
    token_from_url: string,
  ): Promise<OpenedDepositSession | null> {
    const session_token: string | null = read_cookie_value(
      headers.cookie,
      DEPOSIT_SESSION_COOKIE_NAME,
    );
    if (session_token === null) {
      return null;
    }

    const opened_session: OpenedDepositSession | null =
      await this.deposit_sessions.find_by_token_fingerprint(
        fingerprint_deposit_session_token(session_token),
      );
    if (opened_session === null) {
      return null;
    }

    // Le jeton de l'URL doit designer LE lien de la session. Sans cette
    // comparaison, une session ouverte sur son propre lien lirait le dossier
    // d'un autre client en changeant simplement le jeton dans l'adresse.
    const { token_hmac } = this.token_hasher.fingerprint_token(token_from_url);
    if (opened_session.access_link.token_hmac !== token_hmac) {
      return null;
    }

    // Relu a chaque requete : c'est ce qui fait qu'une revocation par l'avocat
    // prend effet au prochain appel, et non a l'expiration de la session.
    const usability = is_deposit_session_usable(
      opened_session.session,
      opened_session.access_link,
      this.clock.now(),
    );

    return usability.usable ? opened_session : null;
  }
}

// Ecrit ici plutot qu'en ajoutant `cookie-parser` : une dependance de plus, un
// middleware global de plus, pour lire une seule valeur.
function read_cookie_value(cookie_header: string | undefined, cookie_name: string): string | null {
  if (cookie_header === undefined) {
    return null;
  }

  for (const cookie_pair of cookie_header.split(';')) {
    const separator_index: number = cookie_pair.indexOf('=');
    if (separator_index === -1) {
      continue;
    }
    if (cookie_pair.slice(0, separator_index).trim() === cookie_name) {
      return cookie_pair.slice(separator_index + 1).trim();
    }
  }

  return null;
}
