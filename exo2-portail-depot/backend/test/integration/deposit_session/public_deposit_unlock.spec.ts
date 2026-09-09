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
import { MAXIMUM_UPLOADS_PER_DEPOSIT_SESSION } from '../../../src/deposited_file/authorize_client_upload';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import { sql } from 'drizzle-orm';
import { Client as MinioClient } from 'minio';
import { parse_minio_connection_settings } from '../../../src/object_storage/minio_object_storage';
import { QUARANTINE_BUCKET_NAME } from '../../../src/object_storage/object_storage';

// Interroge MinIO directement : verifier la suppression par nos propres
// repositories reviendrait a se croire sur parole. Le bucket est prive, donc
// une requete HTTP anonyme repondrait 403 sans rien prouver.
async function object_key_exists(object_key: string): Promise<boolean> {
  const client = new MinioClient(
    parse_minio_connection_settings({
      endpoint_url: process.env[ENVIRONMENT_VARIABLE_NAMES.minio_endpoint] as string,
      access_key: process.env[ENVIRONMENT_VARIABLE_NAMES.minio_root_user] as string,
      secret_key: process.env[ENVIRONMENT_VARIABLE_NAMES.minio_root_password] as string,
    }),
  );

  try {
    await client.statObject(QUARANTINE_BUCKET_NAME, object_key);
    return true;
  } catch {
    return false;
  }
}

// Volontairement minuscule : ces tests postent reellement dans MinIO, et un
// plafond a vingt megaoctets ferait transiter vingt megaoctets par assertion.
const MAXIMUM_DOCUMENT_SIZE_BYTES = 4096;

// Poste vers MinIO exactement comme le fera le navigateur : les champs signes
// d'abord, le contenu en dernier — la specification du POST S3 l'impose.
async function post_to_minio(
  ticket: { upload_url: string; form_fields: Record<string, string> },
  content_length: number,
): Promise<number> {
  const form = new FormData();
  for (const [field_name, field_value] of Object.entries(ticket.form_fields)) {
    form.append(field_name, field_value);
  }
  form.append(
    'file',
    new Blob([new Uint8Array(Buffer.alloc(content_length, 7))], { type: 'application/pdf' }),
  );

  const response = await fetch(ticket.upload_url, { method: 'POST', body: form });
  return response.status;
}

interface IssuedLink {
  deposit_request_id: string;
  token: string;
  pin: string;
}

interface ClientUploadTicketBody {
  deposited_file_id: string;
  upload_url: string;
  form_fields: Record<string, string>;
  expires_at: string;
}

interface ClientDepositBoardBody {
  title: string;
  session_expires_at: string;
  deposit_request_status: string;
  expected_documents: readonly {
    id: string;
    label: string;
    position: number;
    deposited_file: { id: string; display_filename: string; status: string } | null;
  }[];
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
  let database: ApplicationDatabase;

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
            max_size_bytes: MAXIMUM_DOCUMENT_SIZE_BYTES,
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

  function request_upload(
    token: string,
    session_cookie: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${token}/uploads`)
      .set('Cookie', session_cookie)
      .send(body);
  }

  async function read_first_expected_document_id(
    token: string,
    session_cookie: string,
  ): Promise<string> {
    const response = await read_documents(token, session_cookie).expect(200);
    return (response.body as ClientDepositBoardBody).expected_documents[0].id;
  }

  function read_documents(token: string, session_cookie?: string): request.Test {
    const pending = request(app.getHttpServer()).get(`${PUBLIC_DEPOSIT_PATH}/${token}/documents`);
    return session_cookie === undefined ? pending : pending.set('Cookie', session_cookie);
  }

  // Ce que fera la notification `s3:ObjectCreated` a l'etape 6 : l'objet est
  // arrive, la piece occupe desormais l'emplacement. Ecrit ici a la main parce
  // que le webhook n'existe pas encore — sans quoi la regle « un document, une
  // piece » ne serait observable de bout en bout qu'a l'etape suivante.
  async function occupy_slot(ticket: ClientUploadTicketBody): Promise<void> {
    await post_to_minio(ticket, 1024);
    await database.execute(
      sql`UPDATE deposit.deposited_file
          SET status = 'pending_scan', uploaded_at = now()
          WHERE id = ${ticket.deposited_file_id}::uuid`,
    );
  }

  async function read_deposited_count_as_lawyer(deposit_request_id: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .get(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', lawyer_cookie)
      .expect(200);

    const overviews = response.body as readonly {
      id: string;
      deposited_document_count: number;
    }[];

    return overviews.find((overview) => overview.id === deposit_request_id)!
      .deposited_document_count;
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);

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

  it('delivre une autorisation d ecriture que le navigateur peut poster a MinIO', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    const response = await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: 'contrat signe.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(201);

    const ticket = response.body as ClientUploadTicketBody;
    expect(ticket.upload_url).toContain('http');
    expect(ticket.form_fields.key).toContain(expected_document_id);
    expect(new Date(ticket.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  // Les octets ne passent pas par l'API : le ticket doit reellement fonctionner
  // contre MinIO, sinon on ne teste que notre propre mise en forme.
  it('le ticket delivre accepte vraiment un fichier, et refuse ce qui depasse le plafond', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    const response = await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(201);
    const ticket = response.body as ClientUploadTicketBody;

    await expect(post_to_minio(ticket, 1024)).resolves.toBe(204);
    await expect(post_to_minio(ticket, MAXIMUM_DOCUMENT_SIZE_BYTES + 1)).resolves.toBeGreaterThan(
      399,
    );
  });

  it('un emplacement qui n appartient pas a la demande du lien reste introuvable', async () => {
    const link = await issue_link();
    const other_link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const other_session_cookie = await unlock_and_keep_cookie(other_link);
    const other_expected_document_id = await read_first_expected_document_id(
      other_link.token,
      other_session_cookie,
    );

    await request_upload(link.token, session_cookie, {
      expected_document_id: other_expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(404);
  });

  it('un type annonce hors liste blanche est refuse avant tout envoi', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    const refused = await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: 'programme.exe',
      mime_type: 'application/x-msdownload',
      size_bytes: 1024,
    }).expect(422);

    expect(refused.body.reason).toBe('mime_type_not_allowed');
  });

  it('une taille annoncee au-dessus du plafond est refusee avant tout envoi', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    const refused = await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: MAXIMUM_DOCUMENT_SIZE_BYTES + 1,
    }).expect(422);

    expect(refused.body.reason).toBe('declared_size_above_limit');
  });

  it('un corps sans les champs attendus est refuse en 400 : derriere la session, on peut le dire', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);

    await request_upload(link.token, session_cookie, { filename: 'contrat.pdf' }).expect(400);
  });

  it('sans session, aucune autorisation d ecriture n est delivree', async () => {
    const link = await issue_link();

    await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${link.token}/uploads`)
      .send({
        expected_document_id: '11111111-2222-3333-4444-555555555555',
        filename: 'contrat.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
      })
      .expect(401);
  });

  // UN document attendu, UNE piece : le second envoi est refuse tant que le
  // premier n'a pas ete retire. La popup de confirmation vit dans le front, la
  // regle vit ici.
  it('un emplacement occupe refuse une seconde autorisation', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);
    const upload_body = {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    };

    const first = await request_upload(link.token, session_cookie, upload_body).expect(201);
    await occupy_slot(first.body as ClientUploadTicketBody);

    await request_upload(link.token, session_cookie, upload_body).expect(409);
  });

  it('le quota d autorisations par session finit par se fermer', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);
    const upload_body = {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    };

    for (let issued = 0; issued < MAXIMUM_UPLOADS_PER_DEPOSIT_SESSION; issued += 1) {
      await request_upload(link.token, session_cookie, upload_body).expect(201);
    }

    await request_upload(link.token, session_cookie, upload_body).expect(429);
  });

  it('la piece qui occupe un emplacement apparait dans le tableau du client', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    const authorized = await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: '../../etc/passwd',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(201);
    await occupy_slot(authorized.body as ClientUploadTicketBody);

    const board = (await read_documents(link.token, session_cookie).expect(200))
      .body as ClientDepositBoardBody;

    const deposited = board.expected_documents[0].deposited_file;
    expect(deposited?.status).toBe('pending_scan');
    // Le nom vient d'un tiers non authentifie : il ressort nettoye, jamais brut.
    expect(deposited?.display_filename).toBe('passwd');
  });

  // Une reservation dont l'objet n'est jamais arrive ne doit pas s'afficher
  // comme un depot reussi : le client croirait avoir depose.
  it('une reservation sans envoi n apparait pas comme une piece deposee', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(201);

    const board = (await read_documents(link.token, session_cookie).expect(200))
      .body as ClientDepositBoardBody;

    expect(board.expected_documents[0].deposited_file).toBeNull();
  });

  it('le retrait libere l emplacement et permet un nouvel envoi', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);
    const upload_body = {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    };

    const authorized = await request_upload(link.token, session_cookie, upload_body).expect(201);
    const ticket = authorized.body as ClientUploadTicketBody;
    await occupy_slot(ticket);
    await request_upload(link.token, session_cookie, upload_body).expect(409);

    await request(app.getHttpServer())
      .delete(`${PUBLIC_DEPOSIT_PATH}/${link.token}/files/${ticket.deposited_file_id}`)
      .set('Cookie', session_cookie)
      .expect(204);

    await request_upload(link.token, session_cookie, upload_body).expect(201);
  });

  // L'objet doit reellement quitter le bucket : la ligne en base ne suffit pas,
  // sinon un fichier retire resterait telechargeable par qui connait sa cle.
  it('le retrait fait disparaitre l objet du bucket, pas seulement la ligne', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    const authorized = await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(201);
    const ticket = authorized.body as ClientUploadTicketBody;
    await occupy_slot(ticket);

    await request(app.getHttpServer())
      .delete(`${PUBLIC_DEPOSIT_PATH}/${link.token}/files/${ticket.deposited_file_id}`)
      .set('Cookie', session_cookie)
      .expect(204);

    await expect(object_key_exists(ticket.form_fields.key)).resolves.toBe(false);
  });

  it('une piece d un autre lien reste introuvable au retrait', async () => {
    const link = await issue_link();
    const other_link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const other_session_cookie = await unlock_and_keep_cookie(other_link);
    const other_expected_document_id = await read_first_expected_document_id(
      other_link.token,
      other_session_cookie,
    );

    const authorized = await request_upload(other_link.token, other_session_cookie, {
      expected_document_id: other_expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(201);

    await request(app.getHttpServer())
      .delete(
        `${PUBLIC_DEPOSIT_PATH}/${link.token}/files/${(authorized.body as ClientUploadTicketBody).deposited_file_id}`,
      )
      .set('Cookie', session_cookie)
      .expect(404);
  });

  it('sans session, aucun retrait n est possible', async () => {
    const link = await issue_link();

    await request(app.getHttpServer())
      .delete(`${PUBLIC_DEPOSIT_PATH}/${link.token}/files/11111111-2222-3333-4444-555555555555`)
      .expect(401);
  });

  // L'autre bout du parcours : ce que le client depose doit apparaitre au
  // tableau de bord de l'avocat, et n'y apparaitre qu'une fois reellement
  // arrive. C'est le compteur « 2 pieces sur 4 » de la liste des demandes.
  it('une piece deposee remonte au compteur de l avocat, une reservation seule non', async () => {
    const link = await issue_link();
    const session_cookie = await unlock_and_keep_cookie(link);
    const expected_document_id = await read_first_expected_document_id(link.token, session_cookie);

    const authorized = await request_upload(link.token, session_cookie, {
      expected_document_id,
      filename: 'contrat.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    }).expect(201);

    expect(await read_deposited_count_as_lawyer(link.deposit_request_id)).toBe(0);

    await occupy_slot(authorized.body as ClientUploadTicketBody);

    expect(await read_deposited_count_as_lawyer(link.deposit_request_id)).toBe(1);
  });
});
