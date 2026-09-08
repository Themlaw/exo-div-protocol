import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { LAWYER_AUTH_ROUTE_PATHS } from '../../../src/auth/auth_http_contract';

// BetterAuth est monte sous /api/auth/* ; on ne passe que par HTTP, jamais par
// un symbole de la librairie, puisque c'est le seul contrat observable.
const SIGN_IN_EMAIL_PATH = LAWYER_AUTH_ROUTE_PATHS.sign_in;

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

function serialize_response_for_leak_search(response: request.Response): string {
  return JSON.stringify({ body: response.body, headers: response.headers });
}

describe('POST /api/auth/sign-in/email', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let demo_lawyer_email: string;
  let demo_lawyer_password: string;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
    // Le compte de demonstration est cree par l'amorcage de production a partir
    // de ces variables : c'est le seul compte avocat dont on connait les
    // identifiants sans passer par une inscription, qui n'existe pas.
    demo_lawyer_email = require_env('DEMO_LAWYER_EMAIL');
    demo_lawyer_password = require_env('DEMO_LAWYER_PASSWORD');
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('[7] des identifiants corrects creent une session et posent un cookie', async () => {
    const response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });

    expect(response.status).toBe(200);
    const set_cookie_headers = extract_set_cookie_headers(response);
    expect(set_cookie_headers.length).toBeGreaterThan(0);
    expect(
      set_cookie_headers.some((cookie_header: string) =>
        cookie_header.toLowerCase().includes('session'),
      ),
    ).toBe(true);
  });

  it('[8] un mot de passe faux est refuse', async () => {
    const response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: `${demo_lawyer_password}-faux` });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(extract_set_cookie_headers(response).length).toBe(0);
  });

  it("[9] un compte inexistant et un mot de passe faux produisent EXACTEMENT la meme reponse : toute difference serait un oracle d'enumeration de comptes", async () => {
    const unknown_account_email = `compte-inexistant-${randomUUID()}@example.test`;

    const unknown_account_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: unknown_account_email, password: 'un-mot-de-passe-quelconque' });

    const wrong_password_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: `${demo_lawyer_password}-faux` });

    // On compare les deux reponses entre elles, jamais a une valeur attendue
    // fixee a l'avance : c'est l'egalite qui est la propriete recherchee, pas
    // le contenu precis de la reponse.
    expect(unknown_account_response.status).toBe(wrong_password_response.status);
    expect(unknown_account_response.body).toEqual(wrong_password_response.body);
    expect(unknown_account_response.headers['content-type']).toBe(
      wrong_password_response.headers['content-type'],
    );
    expect(extract_set_cookie_headers(unknown_account_response)).toEqual(
      extract_set_cookie_headers(wrong_password_response),
    );
  });

  it("[10] un compte inexistant et un mot de passe faux declenchent le meme nombre d'appels a la fonction de hachage", async () => {
    // On ne mesure jamais un temps de reponse ici : un test chronometrique
    // echoue au hasard sur une machine chargee et finit ignore par l'equipe,
    // ce qui est pire que l'absence du test. Seul un compteur d'appels expose
    // par le harnais donne une assertion deterministe.
    const call_count_before_unknown_account =
      integration_test_application!.password_hashing_call_count();
    await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: `compte-inexistant-${randomUUID()}@example.test`, password: 'peu-importe' });
    const call_count_after_unknown_account =
      integration_test_application!.password_hashing_call_count() -
      call_count_before_unknown_account;

    const call_count_before_wrong_password =
      integration_test_application!.password_hashing_call_count();
    await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: `${demo_lawyer_password}-faux` });
    const call_count_after_wrong_password =
      integration_test_application!.password_hashing_call_count() -
      call_count_before_wrong_password;

    expect(call_count_after_unknown_account).toBe(call_count_after_wrong_password);
  });

  it('[11] deux comptes crees avec le meme mot de passe ont deux hashs differents', async () => {
    // Les comptes avocats sont crees par seed, pas par inscription : on cree
    // ici un second compte via le harnais, avec le meme mot de passe que le
    // compte de demonstration, pour comparer les hashs stockes.
    const second_lawyer_email = `avocat-second-${randomUUID()}@example.test`;
    await integration_test_application!.create_lawyer_account({
      email: second_lawyer_email,
      plaintext_password: demo_lawyer_password,
    });

    const first_account_password_hash =
      await integration_test_application!.read_stored_password_hash(demo_lawyer_email);
    const second_account_password_hash =
      await integration_test_application!.read_stored_password_hash(second_lawyer_email);

    expect(first_account_password_hash).not.toBe(second_account_password_hash);
    expect(first_account_password_hash ?? '').not.toContain(demo_lawyer_password);
    expect(second_account_password_hash ?? '').not.toContain(demo_lawyer_password);
  });

  it("[12] le mot de passe soumis n'apparait nulle part dans la reponse, en cas de succes comme en cas d'echec", async () => {
    const successful_login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: demo_lawyer_password });
    expect(serialize_response_for_leak_search(successful_login_response)).not.toContain(
      demo_lawyer_password,
    );

    const wrong_password = `${demo_lawyer_password}-faux`;
    const failed_login_response = await request(app.getHttpServer())
      .post(SIGN_IN_EMAIL_PATH)
      .send({ email: demo_lawyer_email, password: wrong_password });
    expect(serialize_response_for_leak_search(failed_login_response)).not.toContain(wrong_password);
    expect(serialize_response_for_leak_search(failed_login_response)).not.toContain(
      demo_lawyer_password,
    );
  });

  it('un corps de requete malforme (champs manquants, types inattendus, chaine enorme) est refuse proprement, sans erreur 500', async () => {
    const malformed_request_bodies: readonly Record<string, unknown>[] = [
      {},
      { email: demo_lawyer_email },
      { password: demo_lawyer_password },
      { email: 12345, password: demo_lawyer_password },
      { email: demo_lawyer_email, password: 12345 },
      { email: null, password: demo_lawyer_password },
      { email: demo_lawyer_email, password: 'x'.repeat(1_000_000) },
    ];

    for (const malformed_request_body of malformed_request_bodies) {
      const response = await request(app.getHttpServer())
        .post(SIGN_IN_EMAIL_PATH)
        .send(malformed_request_body);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });
});
