import type { IncomingMessage } from 'node:http';
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
} from './route_access';
import {
  LAWYER_SESSION_READER,
  type LawyerSession,
  type LawyerSessionReader,
} from './lawyer_session_reader';

// La session reconnue est accrochee a la requete sous une clef a nous : les
// controleurs la lisent par `read_authenticated_lawyer_session`, jamais en
// refaisant l'appel a BetterAuth. Deux lectures pourraient diverger, et la
// seconde couterait une requete de plus a chaque appel.
const AUTHENTICATED_LAWYER_SESSION_KEY = Symbol('authenticated_lawyer_session');

type RequestCarryingLawyerSession = IncomingMessage & {
  [AUTHENTICATED_LAWYER_SESSION_KEY]?: LawyerSession;
};

export function read_authenticated_lawyer_session(
  request: IncomingMessage,
): LawyerSession | null {
  return (request as RequestCarryingLawyerSession)[AUTHENTICATED_LAWYER_SESSION_KEY] ?? null;
}

// Enregistre en APP_GUARD, donc applique a TOUTE route du routeur Nest sans
// que personne ait a y penser. C'est le sens du defaut protecteur : une route
// nouvelle est fermee tant que son auteur n'a pas ecrit, noir sur blanc,
// pourquoi elle ne l'est pas.
@Injectable()
export class RouteAccessGuard implements CanActivate {
  constructor(
    @Inject(LAWYER_SESSION_READER) private readonly lawyer_sessions: LawyerSessionReader,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access_kind: RouteAccessKind = resolve_route_access_kind(
      read_own_route_access_kinds([context.getClass(), context.getHandler()]),
    );

    // `internal` et `client_link` ne sont pas ouverts : ils sont authentifies
    // AUTREMENT — secret partage pour l'un, jeton de lien et PIN pour l'autre —
    // et cette verification appartient a leur propre couche, qui seule sait ce
    // qu'elle compare. Les traiter ici obligerait ce garde a connaitre trois
    // mecanismes d'authentification au lieu d'un.
    if (access_kind !== 'lawyer') {
      return true;
    }

    const request: IncomingMessage = context.switchToHttp().getRequest<IncomingMessage>();
    const session: LawyerSession | null = await this.lawyer_sessions.read_lawyer_session(
      request.headers,
    );

    // 401 et non 403 : un 403 confirmerait au passage que la ressource existe.
    if (session === null) {
      throw new UnauthorizedException();
    }

    (request as RequestCarryingLawyerSession)[AUTHENTICATED_LAWYER_SESSION_KEY] = session;
    return true;
  }
}
