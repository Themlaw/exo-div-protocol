import { LAWYER_AUTH_ROUTE_PATHS } from './auth_http_contract';
import type { RouteAccessDeclaration } from './route_access';

// BetterAuth se monte comme handler Node sous un prefixe : ses routes ne
// passent jamais par le routeur Nest, donc ni par le garde global, ni par le
// recensement qui sert a prouver que rien n'est ouvert par omission. Un outil
// qui ne voit pas une surface ne peut pas la declarer sure : on la declare
// donc a la main, ici, et le recensement fusionne les deux sources.
export const LAWYER_AUTH_MOUNT_PATH = '/api/auth';

// Cette liste n'est pas qu'une declaration : c'est aussi la LISTE BLANCHE que
// l'intergiciel de montage applique. Les deux ne peuvent donc pas diverger.
//
// Pourquoi une liste blanche plutot qu'un joker `/api/auth/*` : la version
// installee expose 30 points d'entree sous ce prefixe — `delete-user`,
// `update-user`, `change-email`, `change-password`, `reset-password`,
// `revoke-sessions`, `sign-up/email`... Aucun n'a d'usage dans ce produit, et
// un joker les servirait tous. Le defaut du service est « ferme, chaque
// ouverture est nommee » : il ne peut pas s'arreter a la frontiere d'une
// bibliotheque.
export const NON_NEST_ROUTE_ACCESS_DECLARATIONS: readonly RouteAccessDeclaration[] = [
  { http_method: 'POST', path: LAWYER_AUTH_ROUTE_PATHS.sign_in, access_kind: 'public_auth' },
  { http_method: 'POST', path: LAWYER_AUTH_ROUTE_PATHS.sign_out, access_kind: 'public_auth' },
  { http_method: 'GET', path: LAWYER_AUTH_ROUTE_PATHS.session, access_kind: 'public_auth' },
];
