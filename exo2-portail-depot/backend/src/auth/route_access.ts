import 'reflect-metadata';
import { SetMetadata } from '@nestjs/common';

// Une route « publique » n'est pas une categorie unique. « Ouvert au client
// anonyme » et « appele par MinIO avec un secret partage » n'ont rien a voir :
// les confondre derriere un unique @Public() ferait qu'un oubli sur l'un
// ouvrirait l'autre. Chaque exception au defaut est donc nommee.
export type RouteAccessKind =
  | 'lawyer'
  | 'client_link'
  // Distincte de `client_link` : la premiere est ANONYME — n'importe qui peut
  // frapper la route et c'est le jeton plus le PIN qui decident — la seconde
  // exige une session de depot deja ouverte. Les confondre rendrait anonyme,
  // le jour d'un copier-coller, une route qui rend le contenu d'un dossier.
  | 'client_session'
  | 'internal'
  | 'health'
  // Se connecter ne peut pas exiger d'etre deja connecte : la surface
  // d'authentification est necessairement ouverte. Elle porte un nom a elle
  // plutot que d'emprunter `client_link` ou `health` — la ranger avec les
  // sondes ferait passer pour sans effet de bord la route la plus attaquee du
  // service.
  | 'public_auth';

export const ROUTE_ACCESS_METADATA_KEY = 'portail:route_access';

// Absence de decorateur = route avocat. La protection est le defaut, jamais
// une option qu'on pense a activer.
export const DEFAULT_ROUTE_ACCESS_KIND: RouteAccessKind = 'lawyer';

export const ClientLinkRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS_METADATA_KEY, 'client_link' satisfies RouteAccessKind);

export const ClientSessionRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS_METADATA_KEY, 'client_session' satisfies RouteAccessKind);

export const InternalRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS_METADATA_KEY, 'internal' satisfies RouteAccessKind);

export const HealthRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS_METADATA_KEY, 'health' satisfies RouteAccessKind);

// Une route qui n'est pas servie par le routeur Nest n'a pas de decorateur ou
// accrocher son acces : elle doit etre declaree a la main. Le type est partage
// avec le recensement du routeur pour que les deux surfaces se comparent.
export interface RouteAccessDeclaration {
  http_method: string;
  path: string;
  access_kind: RouteAccessKind;
}

export class ConflictingRouteAccessError extends Error {
  constructor(readonly declared_kinds: readonly RouteAccessKind[]) {
    super(`Une route ne peut porter qu'un seul acces : ${declared_kinds.join(', ')}`);
    this.name = 'ConflictingRouteAccessError';
  }
}

export function resolve_route_access_kind(
  declared_kinds: readonly RouteAccessKind[],
): RouteAccessKind {
  if (declared_kinds.length === 0) {
    return DEFAULT_ROUTE_ACCESS_KIND;
  }

  // Le meme kind peut etre declare a la fois sur la classe et sur la methode :
  // ce n'est pas une ambiguite, seulement une redondance a tolerer.
  const distinct_kinds: RouteAccessKind[] = [...new Set(declared_kinds)];

  if (distinct_kinds.length > 1) {
    throw new ConflictingRouteAccessError(declared_kinds);
  }

  return distinct_kinds[0];
}

// --- Contrat issu de la revue de securite du 2026-09-08 ---
// `Reflect.getMetadata` remonte la chaine de prototypes : un controleur qui
// herite d'une classe decoree recupere son acces sans porter aucun decorateur.
// Un `class DepositRequestsController extends BaseProbeController` — ou la base
// est marquee @HealthRoute() pour une sonde — ouvrirait toutes ses routes sans
// que rien ne soit visible a la lecture, et sans declencher le detecteur de
// conflit puisqu'un seul acces est declare.
//
// Lit donc les metadonnees PROPRES de chaque cible, jamais celles heritees.
export function read_own_route_access_kinds(
  targets: readonly object[],
): readonly RouteAccessKind[] {
  const declared_kinds: RouteAccessKind[] = [];

  for (const target of targets) {
    // `getOwnMetadata` et non `getMetadata` : le second remonte la chaine de
    // prototypes. Et la LISTE complete, pas la valeur gagnante : lu avec un
    // `getAllAndOverride`, qui n'en rend qu'une, ConflictingRouteAccessError
    // deviendrait du code mort et un acces de classe serait ecrase sans bruit.
    const own_kind: unknown = Reflect.getOwnMetadata(ROUTE_ACCESS_METADATA_KEY, target);
    if (own_kind !== undefined) {
      declared_kinds.push(own_kind as RouteAccessKind);
    }
  }

  return declared_kinds;
}
