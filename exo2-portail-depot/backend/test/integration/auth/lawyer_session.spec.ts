import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  create_integration_test_application,
  close_integration_test_application,
  collect_route_access_declarations,
  build_mutable_test_clock,
  type IntegrationTestApplication,
  type RouteAccessDeclaration,
} from '../../helpers/integration_application';
import { LAWYER_AUTH_ROUTE_PATHS } from '../../../src/auth/auth_http_contract';

const SIGN_IN_EMAIL_PATH = LAWYER_AUTH_ROUTE_PATHS.sign_in;
const SIGN_OUT_PATH = LAWYER_AUTH_ROUTE_PATHS.sign_out;

function require_env(variable_name: string): string {
  const value = process.env[variable_name];
  if (value === undefined || value === '') {
    throw new Error(
      `Variable d'environnement ${variable_name} manquante pour les tests d'integration`,
    );
  }
  return value;
}

function extract_set_cookie_headers(response: request.Response): readonly string[] {
  const raw_set_cookie: unknown = response.headers['set-cookie'];
  if (raw_set_cookie === undefined) {
    return [];
  }
  return Array.isArray(raw_set_cookie) ? (raw_set_cookie as readonly string[]) : [raw_set_cookie as string];
}

function find_session_cookie_header(cookie_headers: readonly string[]): string | undefined {
  return cookie_headers.find((cookie_header: string) => cookie_header.toLowerCase().includes('session'));
}

function cookie_name_and_value(cookie_header: string): string {
  const first_segment = cookie_header.split(';')[0];
  return first_segment !== undefined ? first_segment.trim() : cookie_header;
}

function cookie_has_flag(cookie_header: string, flag_name: string): boolean {
  return cookie_header
    .split(';')
    .map((part: string) => part.trim().toLowerCase())
    .includes(flag_name.toLowerCase());
}

function cookie_attribute_value(cookie_header: string, attribute_name: string): string | undefined {
  const prefix = `${attribute_name.toLowerCase()}=`;
  const matching_part = cookie_header
    .split(';')
    .map((part: string) => part.trim())
    .find((part: string) => part.toLowerCase().startsWith(prefix));
  return matching_part !== undefined ? matching_part.slice(prefix.length) : undefined;
}

function find_protected_lawyer_route(
  declarations: readonly RouteAccessDeclaration[],
): RouteAccessDeclaration {
  const lawyer_route = declarations.find(
    (declaration: RouteAccessDeclaration) => declaration.access_kind === 'lawyer',
  );
  if (lawyer_route === undefined) {
    throw new Error(
      "Aucune route de nature 'lawyer' n'est declaree : impossible de verifier la protection " +
        'de session sans une route avocat sur laquelle presenter le cookie.',
    );
  }
  return lawyer_route;
}

function request_protected_route(
  app: INestApplication,
  declaration: RouteAccessDeclaration,
): request.Test {
  const test_agent = request(app.getHttpServer());
  switch (declaration.http_method.toUpperCase()) {
    case 'GET':
      return test_agent.get(declaration.path);
    case 'POST':
      return test_agent.post(declaration.path);
    case 'PUT':
      return test_agent.put(declaration.path);
    case 'PATCH':
      return test_agent.patch(declaration.path);
    case 'DELETE':
      return test_agent.delete(declaration.path);
    default:
      throw new Error(`Methode HTTP non geree par ce test : ${declaration.http_method}`);
  }
}

describe('Session avocat : fixation, attributs de cookie, deconnexion, expiration', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let demo_lawyer_email: string;
  let demo_lawyer_password: string;
  let protected_lawyer_route: RouteAccessDeclaration;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
    demo_lawyer_email = require_env('DEMO_LAWYER_EMAIL');
    demo_lawyer_password = require_env('DEMO_LAWYER_PASSWORD');
    protected_lawyer_route = find_protected_lawyer_route(
      collect_route_access_declarations(app),
    );
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it("[13] l'identifiant de session presente avant la connexion ne survit pas a la connexion : sans regeneration, un identifiant fourni a la victime avant qu'elle se connecte resterait valide apres, et l'attaquant qui l'a fourni entrerait dans le compte", async () => {
    const attacker_supplied_session_cookie = 'better-auth.session_token=attacker-fixed-session-value';

    const login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .set('Cookie', attacker_supplied_session_cookie)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });

    const issued_session_cookie_header = find_session_cookie_header(
      extract_set_cookie_headers(login_response),
    );

    expect(issued_session_cookie_header).toBeDefined();
    expect(cookie_name_and_value(issued_session_cookie_header as string)).not.toBe(
      cookie_name_and_value(attacker_supplied_session_cookie),
    );
  });

  it('[14] le cookie de session porte HttpOnly : un script cote client ne doit pas pouvoir le lire', async () => {
    const login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });
    const session_cookie_header = find_session_cookie_header(
      extract_set_cookie_headers(login_response),
    ) as string;

    expect(cookie_has_flag(session_cookie_header, 'HttpOnly')).toBe(true);
  });

  it('[14] le cookie de session porte Secure : il ne doit jamais transiter en clair', async () => {
    const login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });
    const session_cookie_header = find_session_cookie_header(
      extract_set_cookie_headers(login_response),
    ) as string;

    expect(cookie_has_flag(session_cookie_header, 'Secure')).toBe(true);
  });

  it('[14] le cookie de session porte SameSite=Lax : front et API sont sur le meme domaine, aucune raison de laisser passer plus large', async () => {
    const login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });
    const session_cookie_header = find_session_cookie_header(
      extract_set_cookie_headers(login_response),
    ) as string;

    expect(cookie_attribute_value(session_cookie_header, 'SameSite')).toBe('Lax');
  });

  it("[14] le cookie de session porte un Path restreint, pas le domaine entier", async () => {
    const login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });
    const session_cookie_header = find_session_cookie_header(
      extract_set_cookie_headers(login_response),
    ) as string;

    const path_attribute_value = cookie_attribute_value(session_cookie_header, 'Path');
    expect(path_attribute_value).toBeDefined();
    expect(path_attribute_value).not.toBe('/');
  });

  it('[15] apres deconnexion, le cookie encore possede est refuse sur une route protegee : la session doit etre invalidee cote serveur, effacer le cookie cote client ne protege de rien puisque l\'attaquant a deja la valeur', async () => {
    const login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });
    const session_cookie_header = find_session_cookie_header(
      extract_set_cookie_headers(login_response),
    ) as string;
    const session_cookie_value = cookie_name_and_value(session_cookie_header);

    await request(app.getHttpServer()).post(SIGN_OUT_PATH).set('Cookie', session_cookie_value);

    const response_after_logout = await request_protected_route(app, protected_lawyer_route).set(
      'Cookie',
      session_cookie_value,
    );

    expect(response_after_logout.status).toBeGreaterThanOrEqual(401);
    expect(response_after_logout.status).toBeLessThan(403 + 1);
  });

  it('[16] un cookie dont la valeur a ete modifiee d\'un seul caractere est rejete', async () => {
    const login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });
    const session_cookie_header = find_session_cookie_header(
      extract_set_cookie_headers(login_response),
    ) as string;
    const session_cookie_value = cookie_name_and_value(session_cookie_header);

    const last_character = session_cookie_value.slice(-1);
    const tampered_character = last_character === 'a' ? 'b' : 'a';
    const tampered_cookie_value = `${session_cookie_value.slice(0, -1)}${tampered_character}`;

    const response = await request_protected_route(app, protected_lawyer_route).set(
      'Cookie',
      tampered_cookie_value,
    );

    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(403 + 1);
  });

  it('[16] un cookie entierement forge est rejete', async () => {
    const forged_cookie_value = 'better-auth.session_token=un-cookie-entierement-invente';

    const response = await request_protected_route(app, protected_lawyer_route).set(
      'Cookie',
      forged_cookie_value,
    );

    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(403 + 1);
  });

  it("[17] une session expiree (expiration absolue) est refusee sur une route protegee : une session ne survit pas indefiniment parce qu'on continue de s'en servir", async () => {
    // On pilote une horloge dediee a cette application plutot que
    // `jest.useFakeTimers()` : les faux timers ne couvrent que ce qui lit
    // l'horloge du processus (setTimeout/Date), et rateraient un compteur ou
    // une expiration adosses a un TTL externe (store de session, base, etc.).
    // Faire avancer l'horloge que l'application utilise reellement teste le
    // comportement observable, pas une hypothese sur l'implementation.
    const clock = build_mutable_test_clock(new Date());
    const clocked_test_application = await create_integration_test_application({ clock });

    try {
      const clocked_app = clocked_test_application.app;
      const clocked_protected_lawyer_route = find_protected_lawyer_route(
        collect_route_access_declarations(clocked_app),
      );

      const login_response = await request(clocked_app.getHttpServer())
        .post(SIGN_IN_EMAIL_PATH)
        .send({ email: demo_lawyer_email, password: demo_lawyer_password });
      const session_cookie_header = find_session_cookie_header(
        extract_set_cookie_headers(login_response),
      ) as string;
      const session_cookie_value = cookie_name_and_value(session_cookie_header);

      // Duree tres largement superieure a toute duree de vie absolue
      // raisonnable pour une session avocat.
      clock.advance_seconds(400 * 24 * 60 * 60);

      const response_after_expiry = await request_protected_route(
        clocked_app,
        clocked_protected_lawyer_route,
      ).set('Cookie', session_cookie_value);

      expect(response_after_expiry.status).toBeGreaterThanOrEqual(401);
      expect(response_after_expiry.status).toBeLessThan(403 + 1);
    } finally {
      await close_integration_test_application(clocked_test_application);
    }
  });
});
