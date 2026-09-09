import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import {
  DEPOSIT_REQUESTS_PATH,
  DEPOSIT_SESSION_COOKIE_NAME,
  LAWYER_AUTH_ROUTE_PATHS,
  PUBLIC_DEPOSIT_PATH,
} from '../../../src/auth/auth_http_contract';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS } from '../../../src/deposit_session/unlock_deposit_link';

interface IssuedLink {
  deposit_request_id: string;
  token: string;
  pin: string;
}

interface ClientDepositBoardBody {
  title: string;
  session_expires_at: string;
  expected_documents: readonly { id: string; label: string; position: number }[];
}

// Le lien remis est une URL de FRONT : le jeton que l'API attend en est le
// dernier segment. Le test le derive comme le fera le navigateur, plutot que de
// lire une colonne — c'est le contrat de bout en bout qu'on verifie.
function extract_token_from_delivered_url(delivered_url: string): string {
  return new URL(delivered_url).pathname.split('/').filter(Boolean).at(-1) as string;
}

describe('Deverrouillage public du lien de depot', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let lawyer_cookie: string;

  async function issue_link(pin_length: number = DEFAULT_SECURITY_POLICY.pin_length): Promise<IssuedLink> {
    const response = await request(app.getHttpServer())
      .post(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', lawyer_cookie)
      .send({
        title: 'Dossier de succession',
        security_policy: { ...DEFAULT_SECURITY_POLICY, pin_length },
        expected_documents: [
          {
            label: 'Acte de deces',
            position: 0,
            allowed_mime_types: ['application/pdf'],
            max_size_bytes: 5 * 1024 * 1024,
          },
        ],
      })
      .expect(201);

    const created = response.body as { id: string; access_link: { url: string; pin: string } };
    return {
      deposit_request_id: created.id,
      token: extract_token_from_delivered_url(created.access_link.url),
      pin: created.access_link.pin,
    };
  }

  function unlock(token: string, submitted_pin: unknown): request.Test {
    return request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${token}/unlock`)
      .send({ pin: submitted_pin });
  }

  function wrong_pin_of_same_length(pin: string): string {
    return pin
      .split('')
      .map((digit: string): string => String((Number(digit) + 1) % 10))
      .join('');
  }

  async function unlock_and_keep_cookie(link: IssuedLink): Promise<string> {
    const response = await unlock(link.token, link.pin).expect(200);
    const [session_cookie] = response.headers['set-cookie'] as unknown as string[];
    return session_cookie.split(';')[0];
  }

  function read_documents(token: string, session_cookie?: string): request.Test {
    const pending = request(app.getHttpServer()).get(`${PUBLIC_DEPOSIT_PATH}/${token}/documents`);
    return session_cookie === undefined ? pending : pending.set('Cookie', session_cookie);
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;

    const sign_in_response = await request(app.getHttpServer())
      .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
      .send({
        email: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string,
        password: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password] as string,
      })
      .expect(200);
    lawyer_cookie = sign_in_response.headers['set-cookie'] as unknown as string;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('le bon PIN ouvre une session confinee a la surface publique', async () => {
    const link = await issue_link();

    const response = await unlock(link.token, link.pin).expect(200);

    expect(new Date(response.body.expires_at as string).getTime()).toBeGreaterThan(Date.now());

    const [session_cookie] = response.headers['set-cookie'] as unknown as string[];
    expect(session_cookie).toContain(`${DEPOSIT_SESSION_COOKIE_NAME}=`);
    expect(session_cookie).toContain('HttpOnly');
    expect(session_cookie).toContain('Secure');
    expect(session_cookie).toContain('SameSite=Lax');
    expect(session_cookie).toContain(`Path=${PUBLIC_DEPOSIT_PATH}`);
    expect(session_cookie).toContain(`Max-Age=${CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS}`);
  });

  it("le jeton de session remis n'est jamais le jeton du lien ni le PIN", async () => {
    const link = await issue_link();

    const response = await unlock(link.token, link.pin).expect(200);
    const [session_cookie] = response.headers['set-cookie'] as unknown as string[];

    expect(session_cookie).not.toContain(link.token);
    expect(session_cookie).not.toContain(link.pin);
  });

  // LA propriete exigee : un jeton invente et un PIN faux doivent etre le meme
  // refus. Distinguer reviendrait a repondre « ce lien existe » a qui essaie des
  // jetons au hasard, et l'oracle vaudrait toutes les fuites de la base.
  it('un jeton inconnu et un PIN faux rendent une reponse indistinguable', async () => {
    const link = await issue_link();

    const refused_for_unknown_token = await unlock('jeton-jamais-emis-par-personne', link.pin);
    const refused_for_wrong_pin = await unlock(link.token, wrong_pin_of_same_length(link.pin));

    expect(refused_for_unknown_token.status).toBe(401);
    expect(refused_for_unknown_token.status).toBe(refused_for_wrong_pin.status);
    expect(refused_for_unknown_token.text).toBe(refused_for_wrong_pin.text);
    expect(refused_for_unknown_token.headers['content-type']).toBe(
      refused_for_wrong_pin.headers['content-type'],
    );
    expect(refused_for_unknown_token.headers['set-cookie']).toBeUndefined();
  });

  // Meme refus pour une saisie de mauvaise longueur et pour un corps absurde :
  // une 400 de validation dirait « ce jeton existe, mais ta requete est mal
  // formee », ce que le jeton inconnu ne dit pas.
  it('un PIN de mauvaise longueur et un corps absurde rendent le meme refus', async () => {
    const link = await issue_link();
    const reference = await unlock('jeton-jamais-emis-par-personne', '000000');

    for (const submitted_pin of ['1', '1'.repeat(200), 42, null, undefined]) {
      const refused = await unlock(link.token, submitted_pin);
      expect(refused.status).toBe(reference.status);
      expect(refused.text).toBe(reference.text);
    }
  });

  it('le lien se bloque au plafond d essais et le bon PIN ne l ouvre plus', async () => {
    const link = await issue_link();
    const wrong_pin: string = wrong_pin_of_same_length(link.pin);

    for (let attempt = 1; attempt < DEFAULT_SECURITY_POLICY.max_pin_attempts; attempt += 1) {
      await unlock(link.token, wrong_pin).expect(401);
    }

    // Le dernier echec est celui qui bloque : il l'annonce, parce que le client
    // doit savoir qu'il lui faut un nouveau lien plutot que reessayer.
    const blocking_attempt = await unlock(link.token, wrong_pin).expect(403);
    expect(blocking_attempt.body).toEqual({ state: 'blocked' });

    const with_the_right_pin = await unlock(link.token, link.pin).expect(403);
    expect(with_the_right_pin.body).toEqual({ state: 'blocked' });
    expect(with_the_right_pin.headers['set-cookie']).toBeUndefined();
  });

  it('l etat public rend la longueur du PIN sur un lien actif, et rien de plus', async () => {
    const link = await issue_link(8);

    const response = await request(app.getHttpServer())
      .get(`${PUBLIC_DEPOSIT_PATH}/${link.token}`)
      .expect(200);

    expect(response.body).toEqual({ state: 'active', pin_length: 8 });
  });

  it('l etat public ne dit rien d un jeton inconnu : ni longueur, ni existence', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PUBLIC_DEPOSIT_PATH}/jeton-jamais-emis-par-personne`)
      .expect(200);

    expect(response.body).toEqual({ state: 'invalid' });
  });

  it('la surface publique s ouvre sans session avocat : c est tout son objet', async () => {
    const link = await issue_link();

    await request(app.getHttpServer()).get(`${PUBLIC_DEPOSIT_PATH}/${link.token}`).expect(200);
    await unlock(link.token, link.pin).expect(200);
  });
  it('la session ouverte donne le titre et la liste de ce qui est attendu', async () => {
    const link = await issue_link();
    const session_cookie: string = await unlock_and_keep_cookie(link);

    const response = await read_documents(link.token, session_cookie).expect(200);
    const board = response.body as ClientDepositBoardBody;

    expect(board.title).toBe('Dossier de succession');
    expect(board.expected_documents.map((document) => document.label)).toEqual(['Acte de deces']);
    expect(new Date(board.session_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('sans cookie de session, la route ne rend rien : le PIN n est pas contournable', async () => {
    const link = await issue_link();

    const refused = await read_documents(link.token).expect(401);
    expect(refused.body).not.toHaveProperty('title');
  });

  it('un cookie de session invente est refuse comme une absence de cookie', async () => {
    const link = await issue_link();

    await read_documents(link.token, `${DEPOSIT_SESSION_COOKIE_NAME}=jeton-invente`).expect(401);
  });

  // LA propriete que le garde porte seul : la session designe UN lien. Sans la
  // comparaison, un client legitime lirait le dossier d'un autre en changeant
  // le jeton dans l'adresse.
  it('une session valide ne lit pas le dossier d un autre lien', async () => {
    const own_link = await issue_link();
    const other_link = await issue_link();
    const session_cookie: string = await unlock_and_keep_cookie(own_link);

    await read_documents(own_link.token, session_cookie).expect(200);
    await read_documents(other_link.token, session_cookie).expect(401);
  });

  // Ce que le jeton autoportant n'aurait pas su faire : la revocation prend
  // effet au PROCHAIN appel, pas a l'expiration de la session.
  it('la revocation du lien par l avocat ferme la session en cours', async () => {
    const link = await issue_link();
    const session_cookie: string = await unlock_and_keep_cookie(link);
    await read_documents(link.token, session_cookie).expect(200);

    await request(app.getHttpServer())
      .delete(`${DEPOSIT_REQUESTS_PATH}/${link.deposit_request_id}/links/current`)
      .set('Cookie', lawyer_cookie)
      .expect(204);

    await read_documents(link.token, session_cookie).expect(401);
  });
});
