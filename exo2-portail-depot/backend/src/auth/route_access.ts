import { SetMetadata } from '@nestjs/common';
import { NotImplementedError } from '../domain/not_implemented';

// Une route « publique » n'est pas une categorie unique. « Ouvert au client
// anonyme » et « appele par MinIO avec un secret partage » n'ont rien a voir :
// les confondre derriere un unique @Public() ferait qu'un oubli sur l'un
// ouvrirait l'autre. Chaque exception au defaut est donc nommee.
export type RouteAccessKind = 'lawyer' | 'client_link' | 'internal' | 'health';

export const ROUTE_ACCESS_METADATA_KEY = 'portail:route_access';

// Absence de decorateur = route avocat. La protection est le defaut, jamais
// une option qu'on pense a activer.
export const DEFAULT_ROUTE_ACCESS_KIND: RouteAccessKind = 'lawyer';

export const ClientLinkRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS_METADATA_KEY, 'client_link' satisfies RouteAccessKind);

export const InternalRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS_METADATA_KEY, 'internal' satisfies RouteAccessKind);

export const HealthRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS_METADATA_KEY, 'health' satisfies RouteAccessKind);

export class ConflictingRouteAccessError extends Error {
  constructor(readonly declared_kinds: readonly RouteAccessKind[]) {
    super(`Une route ne peut porter qu'un seul acces : ${declared_kinds.join(', ')}`);
    this.name = 'ConflictingRouteAccessError';
  }
}

export function resolve_route_access_kind(
  _declared_kinds: readonly RouteAccessKind[],
): RouteAccessKind {
  throw new NotImplementedError('resolve_route_access_kind');
}
