import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Catch,
  HttpException,
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

// Un 404 VOULU par un controleur, sur une route qui existe bel et bien. Il
// n'herite deliberement PAS de `NotFoundException` : c'est ce qui le fait
// echapper au filtre ci-dessous, qui masque les chemins inconnus derriere un
// 401 et transformerait sinon cette reponse metier en « non authentifie ».
export class RoutedNotFoundException extends HttpException {
  constructor(body: string | Record<string, unknown>) {
    super(body, 404);
    this.name = 'RoutedNotFoundException';
  }
}

// Un chemin qu'aucun controleur ne sert echappe au garde : Nest repond 404
// avant qu'aucune garde ne tourne. Le defaut protecteur s'arreterait donc pile
// la ou il sert le plus — sur les chemins qu'on n'a pas prevus — et un
// attaquant lirait dans la difference 404/401 la carte de ce qui existe.
//
// Repondre 401 quand personne n'est connecte rend les deux cas indistinguables.
// Une session valide, en revanche, obtient le vrai 404 : l'avocat connecte a le
// droit de savoir qu'il s'est trompe d'URL, et il n'apprend rien qu'il ne
// puisse deja deduire.
//
// Un controleur qui veut lever un vrai 404 — « cet emplacement n'appartient pas
// a cette demande » — utilise `RoutedNotFoundException`, que ce filtre ne
// connait pas : le reecrire en 401 disait a un client parfaitement authentifie
// qu'il ne l'etait pas. Le marquage est explicite parce qu'aucun indice fiable
// ne distingue, ici, un 404 de routeur d'un 404 de controleur.
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

    respond_with_json(
      response,
      session === null ? 401 : 404,
      session === null ? { message: 'Non authentifie' } : { message: 'Ressource introuvable' },
    );
  }
}

function respond_with_json(response: ServerResponse, status_code: number, body: unknown): void {
  response.statusCode = status_code;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}
