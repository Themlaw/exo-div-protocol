import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { APPLICATION_LOGGER } from '../shared/logging/logging.module';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import { collect_route_access_inventory } from './route_access_inventory';
import { DEFAULT_ROUTE_ACCESS_KIND, type RouteAccessDeclaration } from './route_access';

export const ROUTE_ACCESS_LOG_CONTEXT = 'route_access';

// Le recensement tourne au demarrage, et pas seulement en test, pour deux
// raisons qui ne se recouvrent pas.
//
// 1. Il resout l'acces de CHAQUE route. Une route portant deux acces
//    contradictoires leve alors au demarrage, et non le jour ou quelqu'un
//    l'appelle — un conflit qui n'est jamais atteint en test est un conflit
//    qu'on decouvre en production, sur la route concernee.
// 2. Il laisse dans le journal la liste des routes ouvertes de l'artefact
//    REELLEMENT deploye. Le test prouve la meme chose sur le code source ;
//    seul ce journal le prouve sur ce qui tourne.
@Injectable()
export class RouteAccessStartupAudit implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger,
  ) {}

  onApplicationBootstrap(): void {
    const declarations: readonly RouteAccessDeclaration[] = collect_route_access_inventory(
      this.discovery,
    );

    const routes_open_beyond_the_default: readonly string[] = declarations
      .filter(
        (declaration: RouteAccessDeclaration): boolean =>
          declaration.access_kind !== DEFAULT_ROUTE_ACCESS_KIND,
      )
      .map(
        (declaration: RouteAccessDeclaration): string =>
          `${declaration.http_method} ${declaration.path} (${declaration.access_kind})`,
      );

    this.logger.info(ROUTE_ACCESS_LOG_CONTEXT, 'recensement des acces de routes', {
      route_count: declarations.length,
      // Seules les exceptions au defaut sont nommees : la liste complete
      // noierait ce qu'on vient y chercher, et c'est l'ouverture qui se relit,
      // jamais la protection.
      routes_open_beyond_the_default,
    });
  }
}
