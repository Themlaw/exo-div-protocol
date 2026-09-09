import type { IncomingMessage } from 'node:http';
import { NotFoundException } from '@nestjs/common';
import { read_authenticated_lawyer_session } from './route_access.guard';
import type { LawyerSession } from './lawyer_session_reader';

// Le garde global a deja refuse la requete si la session manquait : arriver ici
// sans session serait un garde debranche, pas une requete anonyme. On leve
// plutot que de traiter une demande sans proprietaire — et on leve un 404, le
// meme refus que partout ailleurs cote avocat.
export function require_lawyer_session(request: IncomingMessage): LawyerSession {
  const session: LawyerSession | null = read_authenticated_lawyer_session(request);
  if (session === null) {
    throw new NotFoundException();
  }
  return session;
}
