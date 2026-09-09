import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { NON_NEST_ROUTE_ACCESS_DECLARATIONS } from './non_nest_route_declarations';
import { resolve_served_route_path } from './auth_http_contract';
import {
  read_own_route_access_kinds,
  resolve_route_access_kind,
  type RouteAccessDeclaration,
} from './route_access';

// `RequestMethod` est une enumeration numerique : on la retraduit en verbe HTTP
// pour que le recensement se lise et se compare comme une table de routage, pas
// comme des indices.
const HTTP_METHOD_BY_REQUEST_METHOD: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.SEARCH]: 'SEARCH',
  [RequestMethod.PROPFIND]: 'PROPFIND',
};

function join_route_segments(controller_path: string, handler_path: string): string {
  const segments: readonly string[] = [controller_path, handler_path]
    .map((segment: string): string => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment: string): boolean => segment.length > 0);

  return `/${segments.join('/')}`;
}

function read_metadata_string(target: object, metadata_key: string): string {
  const value: unknown = Reflect.getMetadata(metadata_key, target);
  return typeof value === 'string' ? value : '';
}

// Le recensement sert a prouver qu'aucune route n'est ouverte par omission. Il
// ne peut le prouver que de ce qu'il voit : les routes servies hors du routeur
// Nest — BetterAuth au premier chef — sont donc declarees a la main et
// fusionnees ici, plutot que d'etre absentes et reputees sures.
export function collect_route_access_inventory(
  discovery: DiscoveryService,
): readonly RouteAccessDeclaration[] {
  const metadata_scanner: MetadataScanner = new MetadataScanner();
  const declarations: RouteAccessDeclaration[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance: object | undefined = wrapper.instance;
    if (instance === undefined || instance === null) {
      continue;
    }

    const controller_class: object = instance.constructor;
    const controller_path: string = read_metadata_string(controller_class, PATH_METADATA);
    const prototype: object = Object.getPrototypeOf(instance);

    for (const method_name of metadata_scanner.getAllMethodNames(prototype)) {
      const handler: object = (prototype as Record<string, object>)[method_name];
      const request_method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof request_method !== 'number') {
        continue;
      }

      declarations.push({
        http_method: HTTP_METHOD_BY_REQUEST_METHOD[request_method] ?? 'UNKNOWN',
        // Le chemin REELLEMENT servi, prefixe versionne compris : les
        // decorateurs ne portent que la partie propre au controleur, et un
        // recensement qui s'arreterait la nommerait des routes inexistantes.
        path: resolve_served_route_path(
          join_route_segments(controller_path, read_metadata_string(handler, PATH_METADATA)),
        ),
        // Les metadonnees PROPRES des deux cibles, jamais celles heritees : un
        // controleur qui herite d'une classe decoree ne doit pas recuperer son
        // acces sans porter aucun decorateur.
        access_kind: resolve_route_access_kind(
          read_own_route_access_kinds([controller_class, handler]),
        ),
      });
    }
  }

  return [...declarations, ...NON_NEST_ROUTE_ACCESS_DECLARATIONS];
}
