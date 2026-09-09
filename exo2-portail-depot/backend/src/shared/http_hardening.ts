import type { Application, NextFunction, Request, Response } from 'express';
import type { NodeEnvironment } from './node_environment';

// Deux ans, la valeur usuelle. Sans `preload` : soumettre un domaine a la liste
// des navigateurs est une porte a sens unique — en sortir prend des mois — et
// ce portail vit sur un domaine d'exercice.
export const STRICT_TRANSPORT_SECURITY_MAX_AGE_SECONDS = 63_072_000;

// L'API ne sert aucune ressource a charger : tout est ferme par defaut, et on
// n'ouvre rien. ATTENTION : le jour ou ce serveur servira aussi les pages du
// front, cette politique les cassera net — il faudra une politique distincte
// pour les documents HTML, decidee a l'etape front.
const API_CONTENT_SECURITY_POLICY: string = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Rendus par une fonction plutot que poses en constante : HSTS depend de
// l'environnement, et une constante figee obligerait a le retirer apres coup.
export function build_security_response_headers(
  node_environment: NodeEnvironment,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    // Le lien client porte son jeton DANS l'URL. Sans cela, le referent le
    // livre a tout tiers que la page contacte — une police, une image, un lien
    // clique — et le secret d'acces aux pieces finit dans des journaux qui ne
    // sont pas les notres.
    'referrer-policy': 'no-referrer',
    // Un fichier depose dont le contenu ressemble a du HTML ne doit pas etre
    // execute comme une page de notre origine.
    'x-content-type-options': 'nosniff',
    // Redondant avec `frame-ancestors` sur les navigateurs recents, conserve
    // pour les autres : le clickjacking ne coute rien a fermer deux fois.
    'x-frame-options': 'DENY',
    'content-security-policy': API_CONTENT_SECURITY_POLICY,
  };

  // Uniquement en production : HSTS epingle l'HOTE entier, `localhost` compris.
  // Pose depuis un poste de developpement, il casserait tous les autres
  // services en clair de ce poste, dans le navigateur du developpeur, pour deux
  // ans.
  if (node_environment === 'production') {
    headers['strict-transport-security'] =
      `max-age=${STRICT_TRANSPORT_SECURITY_MAX_AGE_SECONDS}; includeSubDomains`;
  }

  return headers;
}

// `Cache-Control` et `Content-Disposition` ne sont volontairement PAS ici :
// ils dependent de ce que la reponse contient, et les poser sur toutes les
// reponses interdirait de mettre en cache les ressources du front. Ils sont
// rendus par `build_download_response_headers`, au contact du telechargement.
export function apply_http_hardening(
  express_application: Application,
  node_environment: NodeEnvironment,
): void {
  // `X-Powered-By: Express` n'apporte rien et annonce la pile a qui cherche
  // l'exploit correspondant : on choisit ce qu'on publie de son infrastructure.
  express_application.disable('x-powered-by');

  const security_headers = build_security_response_headers(node_environment);

  express_application.use((_request: Request, response: Response, next: NextFunction): void => {
    for (const [header_name, header_value] of Object.entries(security_headers)) {
      response.setHeader(header_name, header_value);
    }
    next();
  });
}
