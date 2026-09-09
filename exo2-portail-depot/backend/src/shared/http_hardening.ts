import type { Application } from 'express';

// `X-Powered-By: Express` etait renvoye sur toutes les reponses. Il n'apporte
// rien et annonce la pile a qui cherche l'exploit correspondant : on choisit ce
// qu'on publie de son infrastructure.
export function apply_http_hardening(express_application: Application): void {
  express_application.disable('x-powered-by');
}
