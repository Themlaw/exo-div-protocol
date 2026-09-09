import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Catch,
  Inject,
  Injectable,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  LAWYER_SESSION_READER,
  type LawyerSessionReader,
} from './lawyer_session_reader';

// Un chemin qu'aucun controleur ne sert echappe au garde : Nest repond 404
// avant qu'aucune garde ne tourne. Le defaut protecteur s'arreterait donc pile
// la ou il sert le plus — sur les chemins qu'on n'a pas prevus — et un
// attaquant lirait dans la difference 404/401 la carte de ce qui existe.
//
// Repondre 401 quand personne n'est connecte rend les deux cas indistinguables.
// Une session valide, en revanche, obtient le vrai 404 : l'avocat connecte a le
// droit de savoir qu'il s'est trompe d'URL, et il n'apprend rien qu'il ne
// puisse deja deduire.
@Injectable()
@Catch(NotFoundException)
export class UnroutedRequestFilter implements ExceptionFilter {
  constructor(
    @Inject(LAWYER_SESSION_READER) private readonly lawyer_sessions: LawyerSessionReader,
  ) {}

  async catch(exception: NotFoundException, host: ArgumentsHost): Promise<void> {
    const http_context = host.switchToHttp();
    const request: IncomingMessage = http_context.getRequest<IncomingMessage>();
    const response: ServerResponse = http_context.getResponse<ServerResponse>();

    const session = await this.lawyer_sessions.read_lawyer_session(request.headers);

    response.statusCode = session === null ? 401 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        session === null ? { message: 'Non authentifie' } : { message: 'Ressource introuvable' },
      ),
    );
  }
}
