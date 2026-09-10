import {
  HttpException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { catchError, type Observable } from 'rxjs';
import { APPLICATION_LOGGER } from './logging/logging.module';
import type { ApplicationLogger } from './logging/application_logger';

const APPLICATION_LOG_CONTEXT = 'application';

// Un segment de chemin est masque des qu'il ne ressemble plus a un mot du
// vocabulaire de l'API. Un token de lien, un UUID de piece, un identifiant de
// demande vivent tous DANS le chemin : les journaliser tels quels donnerait a
// qui lit les journaux de quoi ouvrir un depot. La regle est volontairement
// large — masquer un mot de trop ne coute qu'un peu de precision, laisser
// passer un token coute un acces.
const PLAIN_PATH_SEGMENT = /^[a-z][a-z0-9-]{0,11}$/;

export const MASKED_PATH_SEGMENT = ':segment';

export function mask_secret_path_segments(url: string): string {
  const [path] = url.split('?');

  return (path ?? '')
    .split('/')
    .map((segment: string): string =>
      segment === '' || PLAIN_PATH_SEGMENT.test(segment) ? segment : MASKED_PATH_SEGMENT,
    )
    .join('/');
}

// Un INTERCEPTEUR et non un filtre d'exception : un filtre attrapant tout
// prendrait la place de `UnroutedRequestFilter`, qui masque les chemins
// inconnus derriere un 401. Ici on ne change rien a la reponse — on la laisse
// repartir intacte apres l'avoir journalisee.
//
// Ce qui l'a motive : une autorisation d'envoi rendait 500 en production, et le
// journal ne portait aucune trace de l'appel. Nest ecrit ces pannes dans SON
// logger, qu'on a tu au demarrage pour qu'aucune trace n'echappe au masquage
// des champs sensibles. Le taire sans le remplacer rendait les 500 invisibles.
@Injectable()
export class UnhandledFailureLoggingInterceptor implements NestInterceptor {
  constructor(@Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request: IncomingMessage = context.switchToHttp().getRequest<IncomingMessage>();

    return next.handle().pipe(
      catchError((thrown: unknown): never => {
        // Une HttpException est une reponse VOULUE — un 404 metier, un 401, un
        // 409. La journaliser en `error` noierait les vraies pannes sous le
        // bruit du fonctionnement normal.
        if (!(thrown instanceof HttpException)) {
          this.logger.error(
            APPLICATION_LOG_CONTEXT,
            'panne imprevue pendant le traitement d une requete',
            {
              method: request.method,
              path: mask_secret_path_segments(request.url ?? ''),
              error_name: thrown instanceof Error ? thrown.name : typeof thrown,
              // Le message et la pile, mais rien de la requete : le corps peut
              // porter un PIN, les en-tetes un cookie de session.
              error_message: thrown instanceof Error ? thrown.message : String(thrown),
              error_stack: thrown instanceof Error ? thrown.stack : undefined,
            },
          );
        }

        throw thrown;
      }),
    );
  }
}
