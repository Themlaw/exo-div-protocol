import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  create_integration_test_application,
  close_integration_test_application,
  collect_route_access_declarations,
  type IntegrationTestApplication,
  type RouteAccessDeclaration,
} from '../../helpers/integration_application';
import type { RouteAccessKind } from '../../../src/auth/route_access';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import {
  LAWYER_AUTH_ROUTE_PATHS,
  HEALTH_PATH,
  READINESS_PATH,
  METRICS_PATH,
  INTERNAL_STORAGE_EVENTS_PATH,
} from '../../../src/auth/auth_http_contract';

// Route avocat prise comme temoin : documentee dans api-routes.md, sans
// parametre d'URL, donc la plus simple a interroger sans dependre d'un etat
// metier prealable.
const PROTECTED_LAWYER_ROUTE = '/requests';

// Liste blanche des routes qui n'ont pas a etre 'lawyer'. Elle est ecrite en
// dur : toute route future qui n'y figure pas et qui n'est pas 'lawyer' fait
// echouer ce test, ce qui force un choix conscient plutot qu'un oubli. Ajouter
// une exception est donc un geste explicite qui modifie cette liste.
const NON_LAWYER_ROUTE_WHITELIST: ReadonlyArray<
  (declaration: RouteAccessDeclaration) => boolean
> = [
  (declaration) => declaration.path === HEALTH_PATH,
  (declaration) => declaration.path === READINESS_PATH,
  (declaration) => declaration.path === METRICS_PATH,
  (declaration) =>
    declaration.http_method === 'POST' && declaration.path === INTERNAL_STORAGE_EVENTS_PATH,
  // [F6] Chemins EXACTS, jamais un prefixe. `startsWith('/public/')`
  // pre-approuvait toute route future sous /public/ — exactement le geste
  // implicite que ce test pretend interdire. Ajouter une route ouverte doit
  // rester un ajout relu, ligne par ligne.
  (declaration) =>
    declaration.http_method === 'GET' && declaration.path === '/public/:token',
  (declaration) =>
    declaration.http_method === 'POST' && declaration.path === '/public/:token/unlock',
];

const VALID_ROUTE_ACCESS_KINDS: readonly RouteAccessKind[] = [
  'lawyer',
  'client_link',
  'internal',
  'health',
];

// BetterAuth monte ses propres routes sous /api/auth/* (api-routes.md) : c'est
// la seule indication documentee sur ou se connecter, /api/auth/sign-in/email
// est sa convention par defaut pour email + mot de passe.
async function authenticate_as_demo_lawyer(app: INestApplication): Promise<string> {
  const login_response = await request(app.getHttpServer())
    .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
    .send({
      email: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email],
      password: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password],
    });

  return login_response.headers['set-cookie'];
}

describe('Protection des routes par defaut', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('[1] une route avocat appelee sans cookie de session repond 401', async () => {
    const response = await request(app.getHttpServer()).get(PROTECTED_LAWYER_ROUTE);

    expect(response.status).toBe(401);
  });

  it('[1] repond 401 et non 403 : un 403 confirmerait que la ressource existe', async () => {
    const response = await request(app.getHttpServer()).get(PROTECTED_LAWYER_ROUTE);

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(401);
  });

  it('[2] la meme route avec une session valide repond autre chose que 401', async () => {
    const session_cookie = await authenticate_as_demo_lawyer(app);

    const response = await request(app.getHttpServer())
      .get(PROTECTED_LAWYER_ROUTE)
      .set('Cookie', session_cookie);

    expect(response.status).not.toBe(401);
  });

  // Ce test protege les routes qu'on n'a pas encore ecrites. Le harnais n'a
  // aucun moyen de savoir a l'avance qu'un futur controller sera protege : ce
  // qu'il peut garantir, c'est qu'AUCUNE route enregistree ne se retrouve avec
  // un acces different de 'lawyer' sans figurer dans la liste blanche ci-dessus.
  // Le jour ou quelqu'un ajoute une route ouverte sans y penser, ce test casse
  // la CI, et l'ajouter a la liste blanche devient un geste conscient et relu.
  it('[3] toute route non lawyer est nommee dans la liste blanche, et chaque access_kind est valide', () => {
    const declarations = collect_route_access_declarations(app);

    for (const declaration of declarations) {
      expect(VALID_ROUTE_ACCESS_KINDS).toContain(declaration.access_kind);
    }

    const undeclared_non_lawyer_routes = declarations.filter(
      (declaration) =>
        declaration.access_kind !== 'lawyer' &&
        !NON_LAWYER_ROUTE_WHITELIST.some((is_whitelisted) => is_whitelisted(declaration)),
    );

    expect(undeclared_non_lawyer_routes).toEqual([]);
  });

  it("[3] aucune route ne figure deux fois pour le meme couple methode+chemin", () => {
    const declarations = collect_route_access_declarations(app);

    const method_and_path_pairs = declarations.map(
      (declaration) => `${declaration.http_method} ${declaration.path}`,
    );
    const unique_pairs = new Set(method_and_path_pairs);

    expect(unique_pairs.size).toBe(method_and_path_pairs.length);
  });
});

// [F6] BetterAuth se monte comme handler Node brut sous /api/auth/*, PAS comme
// controleur Nest : ses routes n'apparaissent pas dans le routeur Nest, donc
// ni dans collect_route_access_declarations, ni sous un APP_GUARD global. Le
// defaut protecteur ne s'y applique pas, et l'outil cense le prouver ne voit
// rien. C'est le cas « route generee par une bibliotheque » de la revue.
describe("[F6] la surface d'authentification echappe au recensement du routeur Nest", () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it.each([
    ['sign_in', LAWYER_AUTH_ROUTE_PATHS.sign_in],
    ['sign_out', LAWYER_AUTH_ROUTE_PATHS.sign_out],
    ['session', LAWYER_AUTH_ROUTE_PATHS.session],
  ])('la route %s de BetterAuth est declaree au recensement', (_label: string, path: string) => {
    const declarations = collect_route_access_declarations(app);

    expect(declarations.map((declaration) => declaration.path)).toContain(path);
  });

  it("les routes d'authentification sont declarees comme ouvertes, explicitement et non par omission", () => {
    const declarations = collect_route_access_declarations(app);
    const sign_in_declaration = declarations.find(
      (declaration) => declaration.path === LAWYER_AUTH_ROUTE_PATHS.sign_in,
    );

    // Se connecter ne peut pas exiger d'etre connecte : cette route est
    // forcement ouverte. Ce qui compte est qu'elle le soit par une declaration
    // visible, pas parce qu'elle a echappe au garde.
    expect(sign_in_declaration).toBeDefined();
    expect(sign_in_declaration?.access_kind).not.toBe('lawyer');
  });

  it("une requete sans session sur une route avocat quelconque reste refusee : le garde s'applique bien au-dela du routeur Nest", async () => {
    await request(app.getHttpServer()).get('/api/requests').expect(401);
  });
});
