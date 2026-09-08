import 'reflect-metadata';
import {
  ClientLinkRoute,
  HealthRoute,
  InternalRoute,
  read_own_route_access_kinds,
  resolve_route_access_kind,
  ConflictingRouteAccessError,
  DEFAULT_ROUTE_ACCESS_KIND,
  type RouteAccessKind,
} from '../../../src/auth/route_access';

// Le scenario exact remonte par la revue : quelqu'un factorise une sonde dans
// une classe de base, puis en herite pour reutiliser un helper. Le controleur
// derive ne porte AUCUN decorateur — a la lecture, la regle « absence de
// decorateur = route avocat » semble s'appliquer.
@HealthRoute()
class BaseProbeController {}

class DepositRequestsController extends BaseProbeController {}

@InternalRoute()
class DecoratedInternalController {}

class UndecoratedController {}

describe("[F5] un controleur derive n'herite pas silencieusement de l'acces de sa base", () => {
  it('Reflect.getMetadata remonte bien la chaine de prototypes : le piege est reel', () => {
    // Ce test ne verifie pas notre code, il etablit le fait qui rend le
    // suivant necessaire. S'il tombait, la protection deviendrait inutile.
    const inherited: unknown = Reflect.getMetadata(
      'portail:route_access',
      DepositRequestsController,
    );

    expect(inherited).toBe('health');
  });

  it("les metadonnees PROPRES d'un controleur derive sont vides", () => {
    expect(read_own_route_access_kinds([DepositRequestsController])).toEqual([]);
  });

  it("un controleur derive retombe donc sur l'acces avocat, pas sur celui de sa base", () => {
    const declared_kinds: readonly RouteAccessKind[] = read_own_route_access_kinds([
      DepositRequestsController,
    ]);

    expect(resolve_route_access_kind(declared_kinds)).toBe(DEFAULT_ROUTE_ACCESS_KIND);
  });

  it('la classe de base, elle, garde bien son acces', () => {
    expect(read_own_route_access_kinds([BaseProbeController])).toEqual(['health']);
  });

  it('un controleur sans decorateur ni heritage ne declare rien', () => {
    expect(read_own_route_access_kinds([UndecoratedController])).toEqual([]);
  });
});

describe('[F5] le detecteur de conflit doit recevoir TOUS les acces declares', () => {
  // Autre moitie du finding : lu avec `getAllAndOverride`, qui ne rend qu'un
  // seul acces, ConflictingRouteAccessError devient du code mort et un
  // @InternalRoute() de classe est ecrase sans bruit par un decorateur de
  // methode. La lecture doit donc rendre la LISTE, pas la valeur gagnante.
  it('un acces de methode et un acces de classe differents levent un conflit', () => {
    class ConflictingController {}
    ClientLinkRoute()(ConflictingController);

    const declared_kinds: readonly RouteAccessKind[] = read_own_route_access_kinds([
      ConflictingController,
      DecoratedInternalController,
    ]);

    expect(declared_kinds).toHaveLength(2);
    expect(() => resolve_route_access_kind(declared_kinds)).toThrow(
      ConflictingRouteAccessError,
    );
  });

  it('deux declarations identiques ne sont pas un conflit', () => {
    expect(() =>
      resolve_route_access_kind(read_own_route_access_kinds([DecoratedInternalController])),
    ).not.toThrow();
  });
});
