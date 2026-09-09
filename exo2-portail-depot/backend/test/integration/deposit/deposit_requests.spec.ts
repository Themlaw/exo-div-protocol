import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import {
  DEPOSIT_REQUESTS_PATH,
  LAWYER_AUTH_ROUTE_PATHS,
} from '../../../src/auth/auth_http_contract';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import { EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS } from '../../../src/domain/expected_document';
import {
  DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_BOUNDS,
} from '../../../src/domain/security_policy';



function build_creation_payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Dossier de succession',
    expected_documents: [
      {
        label: "Acte de deces",
        position: 0,
        allowed_mime_types: ['application/pdf'],
        max_size_bytes: 5 * 1024 * 1024,
      },
    ],
    ...overrides,
  };
}

async function sign_in_as_demo_lawyer(app: INestApplication): Promise<string> {
  const response = await request(app.getHttpServer())
    .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
    .send({
      email: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email],
      password: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password],
    });

  const session_cookie: string | undefined = response.headers['set-cookie'];
  if (session_cookie === undefined) {
    throw new Error(`connexion avocat impossible : statut ${response.status}`);
  }
  return session_cookie;
}

describe('Demandes de depot', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let lawyer_cookie: string;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
    lawyer_cookie = await sign_in_as_demo_lawyer(app);
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  describe('POST /api/v1/requests', () => {
    it('cree la demande et rend son identifiant', async () => {
      const response = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(build_creation_payload());

      expect(response.status).toBe(201);
      expect(typeof response.body.id).toBe('string');
    });

    // Les parametres de securite sont facultatifs a la creation : l'avocat qui
    // ne s'en occupe pas doit obtenir des valeurs sures, pas une erreur.
    it('applique la politique de securite par defaut quand elle est absente', async () => {
      const creation = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(build_creation_payload());

      const detail = await request(app.getHttpServer())
        .get(`${DEPOSIT_REQUESTS_PATH}/${creation.body.id}`)
        .set('Cookie', lawyer_cookie);

      expect(detail.body.security_policy).toEqual(DEFAULT_SECURITY_POLICY);
    });

    it("conserve la politique de securite choisie par l'avocat", async () => {
      const chosen_policy = {
        max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.max,
        link_lifetime_days: 1,
        pin_length: SECURITY_POLICY_BOUNDS.pin_length.max,
      };

      const creation = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(build_creation_payload({ security_policy: chosen_policy }));

      const detail = await request(app.getHttpServer())
        .get(`${DEPOSIT_REQUESTS_PATH}/${creation.body.id}`)
        .set('Cookie', lawyer_cookie);

      expect(detail.body.security_policy).toEqual(chosen_policy);
    });

    // [32] La validation rend TOUTES les violations : l'avocat corrige son
    // formulaire en une passe au lieu de decouvrir ses erreurs une par une.
    it('[32] refuse une demande sans document attendu, en nommant la violation', async () => {
      const response = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(build_creation_payload({ expected_documents: [] }));

      expect(response.status).toBe(400);
      expect(response.body.violations).toContain('no_expected_document');
    });

    it('[32] refuse un titre vide et un document sans libelle, et signale les deux a la fois', async () => {
      const response = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(
          build_creation_payload({
            title: '   ',
            expected_documents: [
              {
                label: '',
                position: 0,
                allowed_mime_types: ['application/pdf'],
                max_size_bytes: 1024 * 1024,
              },
            ],
          }),
        );

      expect(response.status).toBe(400);
      expect(response.body.violations).toEqual(
        expect.arrayContaining(['title_missing', 'expected_document_label_missing']),
      );
    });

    it("refuse une taille au-dela du plafond de la plateforme : l'avocat resserre, il ne releve pas", async () => {
      const response = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(
          build_creation_payload({
            expected_documents: [
              {
                label: 'Acte de deces',
                position: 0,
                allowed_mime_types: ['application/pdf'],
                max_size_bytes: EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.max + 1,
              },
            ],
          }),
        );

      expect(response.status).toBe(400);
      expect(response.body.violations).toContain('expected_document_max_size_out_of_bounds');
    });

    // Un parametre de securite regle par le client est un parametre de securite
    // absent : les bornes sont tenues cote serveur, jamais seulement au formulaire.
    it('refuse une politique de securite hors bornes', async () => {
      const response = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(
          build_creation_payload({
            security_policy: {
              max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.max + 1,
              link_lifetime_days: 7,
              pin_length: 6,
            },
          }),
        );

      expect(response.status).toBe(400);
      expect(response.body.violations).toContain('max_pin_attempts_out_of_bounds');
    });

    // Le corps vient d'un client : il peut ne rien contenir de ce qu'on attend,
    // et cela doit produire un refus lisible, jamais une erreur serveur.
    it.each([
      ['un corps vide', {}],
      ['des documents attendus qui ne sont pas une liste', { expected_documents: 'pdf' }],
      ['un titre qui n est pas une chaine', { title: 42 }],
      ['une taille qui n est pas un nombre', {
        expected_documents: [
          {
            label: 'Acte',
            position: 0,
            allowed_mime_types: ['application/pdf'],
            max_size_bytes: 'gros',
          },
        ],
      }],
    ])('refuse %s sans erreur serveur', async (_label: string, payload: object) => {
      const response = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(payload);

      expect(response.status).toBe(400);
    });

    it('refuse la creation sans session avocat', async () => {
      const response = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .send(build_creation_payload());

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/requests', () => {
    it("liste les demandes de l'avocat avec les chiffres d'overview", async () => {
      const creation = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(
          build_creation_payload({
            title: 'Demande listee',
            expected_documents: [
              {
                label: 'Acte de deces',
                position: 0,
                allowed_mime_types: ['application/pdf'],
                max_size_bytes: 1024 * 1024,
              },
              {
                label: 'Livret de famille',
                position: 1,
                allowed_mime_types: ['application/pdf', 'image/jpeg'],
                max_size_bytes: 1024 * 1024,
              },
            ],
          }),
        );

      const listing = await request(app.getHttpServer())
        .get(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie);

      expect(listing.status).toBe(200);
      const listed = listing.body.find(
        (entry: { id: string }): boolean => entry.id === creation.body.id,
      );
      expect(listed).toMatchObject({
        title: 'Demande listee',
        status: 'incomplete',
        expected_document_count: 2,
        deposited_document_count: 0,
      });
    });

    it('rend la plus recente en premier : une liste non ordonnee changerait a chaque chargement', async () => {
      const listing = await request(app.getHttpServer())
        .get(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie);

      const creation_dates: number[] = listing.body.map((entry: { created_at: string }): number =>
        new Date(entry.created_at).getTime(),
      );

      expect(creation_dates).toEqual([...creation_dates].sort((a, b) => b - a));
    });
  });

  describe('GET /api/v1/requests/:id', () => {
    it('rend le detail avec ses documents attendus, dans leur ordre de position', async () => {
      const creation = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(
          build_creation_payload({
            expected_documents: [
              {
                label: 'Second',
                position: 1,
                allowed_mime_types: ['application/pdf'],
                max_size_bytes: 1024 * 1024,
              },
              {
                label: 'Premier',
                position: 0,
                allowed_mime_types: ['image/jpeg'],
                max_size_bytes: 1024 * 1024,
              },
            ],
          }),
        );

      const detail = await request(app.getHttpServer())
        .get(`${DEPOSIT_REQUESTS_PATH}/${creation.body.id}`)
        .set('Cookie', lawyer_cookie);

      expect(detail.status).toBe(200);
      expect(
        detail.body.expected_documents.map((document: { label: string }): string => document.label),
      ).toEqual(['Premier', 'Second']);
    });

    // [36] 404 et jamais 403 : un 403 confirmerait que la demande existe, et
    // l'identifiant d'une demande d'un confrere deviendrait un oracle.
    it("[36] repond 404, jamais 403, pour une demande qui n'appartient pas a l'avocat", async () => {
      const other_lawyer_email = `confrere-${Date.now()}@cabinet-exemple.fr`;
      await integration_test_application!.create_lawyer_account({
        email: other_lawyer_email,
        plaintext_password: 'tulipe orage marbre cerise lanterne',
      });

      const creation = await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .send(build_creation_payload({ title: 'Demande du confrere A' }));

      const other_lawyer_cookie: string = (
        await request(app.getHttpServer())
          .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
          .send({
            email: other_lawyer_email,
            password: 'tulipe orage marbre cerise lanterne',
          })
      ).headers['set-cookie'];

      const detail = await request(app.getHttpServer())
        .get(`${DEPOSIT_REQUESTS_PATH}/${creation.body.id}`)
        .set('Cookie', other_lawyer_cookie);

      expect(detail.status).toBe(404);
      expect(detail.status).not.toBe(403);
    });

    it("[36] la demande d'un confrere n'apparait pas non plus dans sa liste", async () => {
      const other_lawyer_email = `confrere-liste-${Date.now()}@cabinet-exemple.fr`;
      await integration_test_application!.create_lawyer_account({
        email: other_lawyer_email,
        plaintext_password: 'tulipe orage marbre cerise lanterne',
      });

      const other_lawyer_cookie: string = (
        await request(app.getHttpServer())
          .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
          .send({
            email: other_lawyer_email,
            password: 'tulipe orage marbre cerise lanterne',
          })
      ).headers['set-cookie'];

      const listing = await request(app.getHttpServer())
        .get(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', other_lawyer_cookie);

      expect(listing.status).toBe(200);
      expect(listing.body).toEqual([]);
    });

    // Un identifiant qui n'est pas un UUID ne doit pas atteindre Postgres : la
    // requete leverait, et un 500 distinguerait cette entree de toutes les autres.
    it("repond 404 pour un identifiant qui n'est pas un UUID, sans erreur serveur", async () => {
      const detail = await request(app.getHttpServer())
        .get(`${DEPOSIT_REQUESTS_PATH}/pas-un-uuid`)
        .set('Cookie', lawyer_cookie);

      expect(detail.status).toBe(404);
    });
  });
});
