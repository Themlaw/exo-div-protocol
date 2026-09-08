import { Controller, Get } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  RouteAccessStartupAudit,
  ROUTE_ACCESS_LOG_CONTEXT,
} from '../../../src/auth/route_access_startup_audit';
import {
  ConflictingRouteAccessError,
  HealthRoute,
  InternalRoute,
} from '../../../src/auth/route_access';
import { build_capturing_logger } from '../../helpers/capturing_logger';

@Controller('requests')
class DepositRequestsControllerDouble {
  @Get()
  list(): readonly string[] {
    return [];
  }
}

@Controller('health')
@HealthRoute()
class HealthControllerDouble {
  @Get()
  probe(): string {
    return 'ok';
  }
}

// Deux acces sur la meme route : ni le decorateur de classe ni celui de methode
// ne peut « gagner » sans qu'un humain ait tranche.
@Controller('ambigu')
@HealthRoute()
class ContradictoryControllerDouble {
  @Get()
  @InternalRoute()
  read(): string {
    return 'ok';
  }
}

// Un faux DiscoveryService plutot qu'une application Nest complete : ce qu'on
// verifie ici est le comportement de l'audit face aux controleurs recenses, pas
// la mecanique d'amorcage de Nest, qui est deja couverte par l'integration.
function build_discovery_service_double(
  controller_instances: readonly object[],
): DiscoveryService {
  return {
    getControllers: (): readonly { instance: object }[] =>
      controller_instances.map((instance: object) => ({ instance })),
  } as unknown as DiscoveryService;
}

describe('RouteAccessStartupAudit', () => {
  it('journalise le nombre de routes et nomme celles qui sortent du defaut', () => {
    const logger = build_capturing_logger();
    const audit = new RouteAccessStartupAudit(
      build_discovery_service_double([
        new DepositRequestsControllerDouble(),
        new HealthControllerDouble(),
      ]),
      logger,
    );

    audit.onApplicationBootstrap();

    const entries = logger.entries_at_level('info');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.context).toBe(ROUTE_ACCESS_LOG_CONTEXT);
    // Les routes declarees a la main y figurent aussi : c'est tout l'objet du
    // recensement que de reunir les deux surfaces en une seule liste relisible.
    expect(entries[0]!.fields?.routes_open_beyond_the_default).toEqual([
      'GET /health (health)',
      'POST /api/auth/sign-in/email (public_auth)',
      'POST /api/auth/sign-out (public_auth)',
      'GET /api/auth/get-session (public_auth)',
    ]);
  });

  it(
    "une route portant deux acces contradictoires fait echouer le DEMARRAGE : sans cela le " +
      "conflit n'apparait qu'au premier appel de cette route, donc peut-etre jamais avant la production",
    () => {
      const audit = new RouteAccessStartupAudit(
        build_discovery_service_double([new ContradictoryControllerDouble()]),
        build_capturing_logger(),
      );

      expect(() => audit.onApplicationBootstrap()).toThrow(ConflictingRouteAccessError);
    },
  );

  it("une route avocat n'est pas nommee dans le journal : c'est l'ouverture qui se relit, pas la protection", () => {
    const logger = build_capturing_logger();
    const audit = new RouteAccessStartupAudit(
      build_discovery_service_double([new DepositRequestsControllerDouble()]),
      logger,
    );

    audit.onApplicationBootstrap();

    const named_routes = logger.entries_at_level('info')[0]!.fields
      ?.routes_open_beyond_the_default as readonly string[];

    expect(named_routes).not.toContain('GET /requests (lawyer)');
    expect(named_routes.some((route: string): boolean => route.includes('/requests'))).toBe(false);
  });
});
