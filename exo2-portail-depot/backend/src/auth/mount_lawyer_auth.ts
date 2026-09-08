import type { IncomingMessage, ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import type { LawyerAuth } from './lawyer_auth';
import { NON_NEST_ROUTE_ACCESS_DECLARATIONS } from './non_nest_route_declarations';
import { LAWYER_AUTH_LOG_CONTEXT } from './lawyer_auth_logging';
import type { ApplicationLogger } from '../shared/logging/application_logger';

// Les couples methode+chemin effectivement servis, derives des declarations :
// une route ouverte au montage et absente du recensement — ou l'inverse —
// serait une surface que rien ne decrit.
const MOUNTED_LAWYER_AUTH_ROUTES: ReadonlySet<string> = new Set(
  NON_NEST_ROUTE_ACCESS_DECLARATIONS.map(
    (declaration): string => `${declaration.http_method} ${declaration.path}`,
  ),
);

// Monte en amont du routeur Nest plutot que via `app.use(prefixe, handler)` :
// un montage par prefixe retire ce prefixe de `req.url`, et BetterAuth, qui
// reconstruit l'URL complete a partir de la requete Node, ne reconnaitrait plus
// aucune de ses routes.
//
// Comparaison sur le chemin EXACT, jamais sur un prefixe : la bibliotheque
// expose une trentaine d'autres points d'entree sous le meme prefixe, et un
// `startsWith` les servirait tous. Ce qui n'est pas reconnu ici n'est pas
// refuse par cet intergiciel — il passe la main au routeur Nest, ou il n'existe
// aucun controleur, donc au traitement par defaut des routes inconnues.
export function targets_mounted_lawyer_auth_route(
  http_method: string,
  request_url: string,
): boolean {
  const path_without_query: string = request_url.split('?')[0] ?? '';
  return MOUNTED_LAWYER_AUTH_ROUTES.has(
    `${http_method.toUpperCase()} ${path_without_query}`,
  );
}

// A appeler AVANT `app.init()` : l'intergiciel doit passer avant le routeur
// Nest, qui repondrait 404 sur ces chemins puisqu'aucun controleur ne les
// declare.
// Cet intergiciel est le seul point de sortie de BetterAuth : il n'y a aucun
// filtre d'exception Nest derriere lui pour rattraper un rejet. Une promesse
// abandonnee y produirait deux pannes a la fois — un rejet non gere, que Node
// traite par defaut en arretant le processus, et un client qui attend une
// reponse qui ne viendra jamais.
export function report_lawyer_auth_failure(
  error: unknown,
  response: ServerResponse,
  logger: ApplicationLogger,
): void {
  logger.error(LAWYER_AUTH_LOG_CONTEXT, "echec du traitement d'une requete d'authentification", {
    error,
  });

  // Une reponse partiellement ecrite ne peut plus recevoir de statut : la
  // reecrire leverait a son tour, dans le gestionnaire d'erreur lui-meme.
  if (response.headersSent) {
    response.destroy();
    return;
  }

  // Aucun detail au client : la cause est dans le journal, ou elle est masquee.
  response.statusCode = 500;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ message: 'Erreur interne' }));
}

export function mount_lawyer_auth_handler(
  app: INestApplication,
  lawyer_auth: LawyerAuth,
  logger: ApplicationLogger,
): void {
  const handle_lawyer_auth_request = toNodeHandler(lawyer_auth);

  app.use(
    (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
      if (!targets_mounted_lawyer_auth_route(request.method ?? '', request.url ?? '')) {
        next();
        return;
      }

      handle_lawyer_auth_request(request, response).catch((error: unknown): void => {
        report_lawyer_auth_failure(error, response, logger);
      });
    },
  );
}
