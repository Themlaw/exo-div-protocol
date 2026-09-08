import { build_lawyer_auth, type LawyerAuth } from '../../../src/auth/lawyer_auth';
import { targets_mounted_lawyer_auth_route } from '../../../src/auth/mount_lawyer_auth';
import {
  LAWYER_AUTH_MOUNT_PATH,
  NON_NEST_ROUTE_ACCESS_DECLARATIONS,
} from '../../../src/auth/non_nest_route_declarations';
import { LAWYER_AUTH_ROUTE_PATHS } from '../../../src/auth/auth_http_contract';

interface LawyerAuthEndpoint {
  path: string;
  http_methods: readonly string[];
}

// L'instance est construite sans base ni hacheur reels : on n'appelle aucune
// route, on lit seulement la table des points d'entree que la bibliotheque
// declare. C'est cette table, et non une liste recopiee a la main, qui doit
// faire foi — une liste recopiee ne verrait jamais un ajout de version.
function build_lawyer_auth_for_inspection(): LawyerAuth {
  return build_lawyer_auth({
    database: {} as never,
    password_hasher: {
      hash_plaintext_password: async (): Promise<string> => '',
      verify_plaintext_password: async (): Promise<boolean> => false,
    },
    public_base_url: 'http://localhost:3000',
    node_environment: 'test',
    logger: { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {} },
  });
}

function list_library_endpoints(lawyer_auth: LawyerAuth): readonly LawyerAuthEndpoint[] {
  const endpoints: LawyerAuthEndpoint[] = [];

  for (const value of Object.values(lawyer_auth.api as Record<string, unknown>)) {
    const endpoint = value as { path?: unknown; options?: { method?: unknown } };
    if (typeof endpoint.path !== 'string') {
      continue;
    }

    const declared_method: unknown = endpoint.options?.method;
    const http_methods: readonly string[] = Array.isArray(declared_method)
      ? declared_method.filter((method): method is string => typeof method === 'string')
      : typeof declared_method === 'string'
        ? [declared_method]
        : [];

    endpoints.push({
      path: `${LAWYER_AUTH_MOUNT_PATH}${endpoint.path}`,
      http_methods,
    });
  }

  return endpoints;
}

const MOUNTED_ROUTE_KEYS: ReadonlySet<string> = new Set(
  NON_NEST_ROUTE_ACCESS_DECLARATIONS.map(
    (declaration): string => `${declaration.http_method} ${declaration.path}`,
  ),
);

describe("la surface d'authentification reellement montee", () => {
  const lawyer_auth: LawyerAuth = build_lawyer_auth_for_inspection();

  it('les trois routes dont le produit a besoin sont bien servies', () => {
    expect(targets_mounted_lawyer_auth_route('POST', LAWYER_AUTH_ROUTE_PATHS.sign_in)).toBe(true);
    expect(targets_mounted_lawyer_auth_route('POST', LAWYER_AUTH_ROUTE_PATHS.sign_out)).toBe(true);
    expect(targets_mounted_lawyer_auth_route('GET', LAWYER_AUTH_ROUTE_PATHS.session)).toBe(true);
  });

  it(
    'toute autre route exposee par la bibliotheque est fermee : elle en declare une trentaine ' +
      "sous le meme prefixe, et aucune n'a d'usage dans ce produit",
    () => {
      const library_endpoints: readonly LawyerAuthEndpoint[] =
        list_library_endpoints(lawyer_auth);

      // Sans cette borne, le balayage passerait au vert le jour ou
      // l'enumeration cesserait de rendre quoi que ce soit : un test qui ne
      // trouve rien a verifier ne verifie rien.
      expect(library_endpoints.length).toBeGreaterThan(MOUNTED_ROUTE_KEYS.size);

      const reachable_routes_outside_the_allowlist: string[] = [];

      for (const endpoint of library_endpoints) {
        for (const http_method of endpoint.http_methods) {
          const route_key = `${http_method.toUpperCase()} ${endpoint.path}`;
          if (MOUNTED_ROUTE_KEYS.has(route_key)) {
            continue;
          }
          if (targets_mounted_lawyer_auth_route(http_method, endpoint.path)) {
            reachable_routes_outside_the_allowlist.push(route_key);
          }
        }
      }

      expect(reachable_routes_outside_the_allowlist).toEqual([]);
    },
  );

  it.each([
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/delete-user'],
    ['POST', '/api/auth/update-user'],
    ['POST', '/api/auth/change-email'],
    ['POST', '/api/auth/change-password'],
    ['POST', '/api/auth/reset-password'],
    ['POST', '/api/auth/revoke-sessions'],
    ['GET', '/api/auth/list-sessions'],
  ])(
    // Nommees une par une, en plus du balayage automatique : le balayage prouve
    // qu'aucune route de la bibliotheque ne passe, ces cas-ci disent lesquelles
    // nous inquietaient, et resteraient rouges meme si l'enumeration cessait de
    // fonctionner un jour.
    'la route sensible %s %s est fermee',
    (http_method: string, path: string) => {
      expect(targets_mounted_lawyer_auth_route(http_method, path)).toBe(false);
    },
  );

  it(
    "aucune route n'est servie par simple prefixe : un chemin inconnu sous /api/auth " +
      "ne doit pas passer parce qu'il commence bien",
    () => {
      expect(targets_mounted_lawyer_auth_route('POST', '/api/auth/sign-in/email/extra')).toBe(false);
      expect(targets_mounted_lawyer_auth_route('POST', '/api/auth')).toBe(false);
      expect(targets_mounted_lawyer_auth_route('GET', '/api/authentique')).toBe(false);
    },
  );

  it('la methode compte autant que le chemin : get-session en POST est ferme', () => {
    expect(targets_mounted_lawyer_auth_route('POST', LAWYER_AUTH_ROUTE_PATHS.session)).toBe(false);
    expect(targets_mounted_lawyer_auth_route('GET', LAWYER_AUTH_ROUTE_PATHS.sign_in)).toBe(false);
  });

  it("la chaine de requete ne sert pas a contourner la comparaison de chemin", () => {
    expect(
      targets_mounted_lawyer_auth_route('GET', `${LAWYER_AUTH_ROUTE_PATHS.session}?disableRefresh=true`),
    ).toBe(true);
    expect(targets_mounted_lawyer_auth_route('POST', '/api/auth/delete-user?x=1')).toBe(false);
  });
});
