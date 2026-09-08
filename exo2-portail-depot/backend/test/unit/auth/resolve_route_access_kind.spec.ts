import {
  resolve_route_access_kind,
  ConflictingRouteAccessError,
  DEFAULT_ROUTE_ACCESS_KIND,
  type RouteAccessKind,
} from '../../../src/auth/route_access';

describe('resolve_route_access_kind', () => {
  it("aucun kind declare ne renvoie pas une absence mais 'lawyer' : la protection est le defaut, jamais une option qu'on pense a activer", () => {
    const declared_kinds: readonly RouteAccessKind[] = [];

    expect(resolve_route_access_kind(declared_kinds)).toBe(
      DEFAULT_ROUTE_ACCESS_KIND,
    );
  });

  it.each<RouteAccessKind>(['lawyer', 'client_link', 'internal', 'health', 'public_auth'])(
    'un unique kind declare (%s) est renvoye tel quel',
    (kind: RouteAccessKind) => {
      expect(resolve_route_access_kind([kind])).toBe(kind);
    },
  );

  it("deux kinds declares simultanement levent ConflictingRouteAccessError plutot qu'une resolution par priorite : une route a la fois 'internal' et 'client_link' est une ambiguite que personne ne doit avoir a arbitrer mentalement", () => {
    const declared_kinds: readonly RouteAccessKind[] = ['internal', 'client_link'];

    expect(() => resolve_route_access_kind(declared_kinds)).toThrow(
      ConflictingRouteAccessError,
    );

    try {
      resolve_route_access_kind(declared_kinds);
      throw new Error('resolve_route_access_kind aurait du lever');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConflictingRouteAccessError);
      expect((error as ConflictingRouteAccessError).declared_kinds).toEqual(
        declared_kinds,
      );
    }
  });

  it('le meme kind declare deux fois (classe puis methode) est une redondance et ne leve pas', () => {
    const declared_kinds: readonly RouteAccessKind[] = ['client_link', 'client_link'];

    expect(resolve_route_access_kind(declared_kinds)).toBe('client_link');
  });
});
