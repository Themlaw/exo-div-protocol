import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  create_integration_test_application,
  close_integration_test_application,
  build_mutable_test_clock,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import {
  LOGIN_BACKOFF_BOUNDS,
  LOGIN_IP_RATE_LIMIT_BOUNDS,
} from '../../../src/auth/login_throttling';
import { LAWYER_AUTH_ROUTE_PATHS } from '../../../src/auth/auth_http_contract';

// BetterAuth monte ses propres routes sous /api/auth/* : il n'existe pas de
// POST /auth/login maison (voir memories/api-routes.md, ecart 2).
const LOGIN_PATH = LAWYER_AUTH_ROUTE_PATHS.sign_in;

// Identifiants reels du compte de demo, injectes par l'amorcage de production
// (voir memories/auth-avocat.md). Une valeur de repli permet au fichier de
// compiler et de s'executer meme sans variables d'environnement positionnees.
const VALID_LAWYER_EMAIL = process.env.DEMO_LAWYER_EMAIL ?? 'avocat.demo@example.test';
const VALID_LAWYER_PASSWORD =
  process.env.DEMO_LAWYER_PASSWORD ?? 'CorrectHorseBatteryStaple!1';

interface LoginCredentials {
  email: string;
  password: string;
}

function wrong_password_attempt(email: string): LoginCredentials {
  return { email, password: 'ce-mot-de-passe-est-volontairement-faux' };
}

function attempt_login(
  app: INestApplication,
  credentials: LoginCredentials,
  extra_headers?: Readonly<Record<string, string>>,
): request.Test {
  const pending_request = request(app.getHttpServer())
    .post(LOGIN_PATH)
    .send(credentials);

  if (extra_headers === undefined) {
    return pending_request;
  }

  return Object.entries(extra_headers).reduce(
    (built_request, [header_name, header_value]) =>
      built_request.set(header_name, header_value),
    pending_request,
  );
}

function was_slowed_or_refused(response: request.Response): boolean {
  return response.status === 429 || response.headers['retry-after'] !== undefined;
}

// Genere des comptes cibles distincts : l'attaquant qui change de compte a
// chaque essai ne doit jamais retomber sur le meme compteur par-compte.
function distinct_target_emails(count: number, seed: string): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `cible-${seed}-${index}@example.test`,
  );
}

describe('rate limiting sur la connexion avocat', () => {
  describe('[18] limitation par compte', () => {
    let integration_test_application: IntegrationTestApplication | undefined;
    let app: INestApplication;

    beforeAll(async () => {
      integration_test_application = await create_integration_test_application();
      app = integration_test_application.app;
    });

    afterAll(async () => {
      await close_integration_test_application(integration_test_application);
    });

    it('[18] des tentatives echouees repetees sur le meme compte finissent par etre ralenties ou refusees', async () => {
      const target_email = 'cible-compte-unique@example.test';
      const attempts_needed_to_exceed_backoff =
        LOGIN_BACKOFF_BOUNDS.attempts_before_backoff + 5;

      let last_response: request.Response | undefined;
      for (
        let attempt_index = 0;
        attempt_index < attempts_needed_to_exceed_backoff;
        attempt_index += 1
      ) {
        last_response = await attempt_login(app, wrong_password_attempt(target_email));
      }

      expect(last_response).toBeDefined();
      expect(was_slowed_or_refused(last_response as request.Response)).toBe(true);
    });
  });

  describe('[19] et [19bis] limitation par IP', () => {
    let integration_test_application: IntegrationTestApplication | undefined;
    let app: INestApplication;

    beforeAll(async () => {
      integration_test_application = await create_integration_test_application();
      app = integration_test_application.app;
    });

    afterAll(async () => {
      await close_integration_test_application(integration_test_application);
    });

    it('[19] des tentatives echouees repetees depuis la meme IP finissent par produire un 429', async () => {
      const target_email = 'cible-meme-ip@example.test';
      const attempt_count = LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window + 5;

      let last_response: request.Response | undefined;
      for (
        let attempt_index = 0;
        attempt_index < attempt_count;
        attempt_index += 1
      ) {
        last_response = await attempt_login(app, wrong_password_attempt(target_email));
        if (last_response.status === 429) {
          break;
        }
      }

      expect(last_response?.status).toBe(429);
    });

    // LE TEST QUI COMPTE : sans limite par IP, il suffirait de changer de
    // compte cible a chaque essai pour ne jamais declencher la limite par
    // compte, et l'attaquant garderait un debit illimite depuis une seule
    // machine.
    it('[19bis] des tentatives reparties sur plusieurs comptes differents depuis une seule IP sont quand meme limitees', async () => {
      const attempt_count = LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window + 5;
      const target_emails = distinct_target_emails(attempt_count, 'multi-compte');

      let last_response: request.Response | undefined;
      for (const target_email of target_emails) {
        last_response = await attempt_login(app, wrong_password_attempt(target_email));
        if (last_response.status === 429) {
          break;
        }
      }

      expect(last_response?.status).toBe(429);
    });
  });

  describe('[20] et [20bis] les en-tetes fournis par le client ne sont pas une identite de limitation', () => {
    let integration_test_application: IntegrationTestApplication | undefined;
    let app: INestApplication;

    beforeAll(async () => {
      integration_test_application = await create_integration_test_application();
      app = integration_test_application.app;
    });

    afterAll(async () => {
      await close_integration_test_application(integration_test_application);
    });

    // Un en-tete fourni par le client ne peut jamais servir seul d'identite
    // de limitation : sinon la protection se contourne en une ligne, en
    // changeant sa valeur a chaque requete.
    it("[20] un X-Forwarded-For forge et change a chaque requete ne remet pas le compteur a zero", async () => {
      const target_email = 'cible-xff-forge@example.test';
      const attempt_count = LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window + 5;

      let last_response: request.Response | undefined;
      for (
        let attempt_index = 0;
        attempt_index < attempt_count;
        attempt_index += 1
      ) {
        last_response = await attempt_login(app, wrong_password_attempt(target_email), {
          'X-Forwarded-For': `10.0.${attempt_index % 256}.${(attempt_index * 7) % 256}`,
        });
        if (last_response.status === 429) {
          break;
        }
      }

      expect(last_response?.status).toBe(429);
    });

    it.each(['X-Real-IP', 'Forwarded'])(
      "[20bis] l'en-tete %s, force et change a chaque requete, ne remet pas non plus le compteur a zero",
      async (spoofable_header_name: string) => {
        const target_email = `cible-${spoofable_header_name.toLowerCase()}@example.test`;
        const attempt_count = LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window + 5;

        let last_response: request.Response | undefined;
        for (
          let attempt_index = 0;
          attempt_index < attempt_count;
          attempt_index += 1
        ) {
          const header_value =
            spoofable_header_name === 'Forwarded'
              ? `for=10.0.${attempt_index % 256}.${(attempt_index * 3) % 256}`
              : `10.0.${attempt_index % 256}.${(attempt_index * 3) % 256}`;

          last_response = await attempt_login(app, wrong_password_attempt(target_email), {
            [spoofable_header_name]: header_value,
          });
          if (last_response.status === 429) {
            break;
          }
        }

        expect(last_response?.status).toBe(429);
      },
    );
  });

  describe("[20ter] les variantes d'URL ne creent pas un compteur distinct", () => {
    let integration_test_application: IntegrationTestApplication | undefined;
    let app: INestApplication;

    beforeAll(async () => {
      integration_test_application = await create_integration_test_application();
      app = integration_test_application.app;
    });

    afterAll(async () => {
      await close_integration_test_application(integration_test_application);
    });

    it("[20ter] une majuscule ou un slash final sur l'URL de connexion ne permet pas de repartir de zero", async () => {
      const target_email = 'cible-variantes-url@example.test';
      const url_variants = [LOGIN_PATH, LOGIN_PATH.toUpperCase(), `${LOGIN_PATH}/`];
      const attempt_count = LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window + 5;

      let last_response: request.Response | undefined;
      for (
        let attempt_index = 0;
        attempt_index < attempt_count;
        attempt_index += 1
      ) {
        const path_for_this_attempt = url_variants[attempt_index % url_variants.length];
        last_response = await request(app.getHttpServer())
          .post(path_for_this_attempt)
          .send(wrong_password_attempt(target_email));
        if (last_response.status === 429) {
          break;
        }
      }

      expect(last_response?.status).toBe(429);
    });
  });

  describe("[21] absence de verrouillage : la fenetre ecoulee, un compte redevient utilisable", () => {
    let integration_test_application: IntegrationTestApplication | undefined;
    let app: INestApplication;
    let clock: ReturnType<typeof build_mutable_test_clock>;

    beforeAll(async () => {
      clock = build_mutable_test_clock(new Date());
      integration_test_application = await create_integration_test_application({ clock });
      app = integration_test_application.app;
    });

    afterAll(async () => {
      await close_integration_test_application(integration_test_application);
    });

    // Un avocat verrouille n'aurait personne pour le debloquer, et connaitre
    // son email suffirait a le mettre dehors : on ralentit les tentatives,
    // on ne ferme jamais definitivement l'acces a un compte legitime.
    //
    // NOTE METHODE : on n'utilise jamais un vrai sleep pour attendre
    // l'ecoulement de la fenetre (test lent et instable), ni
    // `jest.useFakeTimers()` : les faux timers ne couvrent que ce qui lit
    // l'horloge du processus (setTimeout/Date), et rateraient un compteur
    // adosse a un TTL externe (store Redis, etc.). On avance a la place
    // l'horloge que l'application utilise reellement, via le harnais : cela
    // teste le comportement observable, pas une hypothese sur
    // l'implementation.
    it("[21] apres avoir declenche la limite, une fois la fenetre ecoulee, des identifiants corrects passent de nouveau et la session est cree", async () => {
      const attempts_needed_to_exceed_backoff =
        LOGIN_BACKOFF_BOUNDS.attempts_before_backoff + 5;

      for (
        let attempt_index = 0;
        attempt_index < attempts_needed_to_exceed_backoff;
        attempt_index += 1
      ) {
        await attempt_login(app, wrong_password_attempt(VALID_LAWYER_EMAIL));
      }

      clock.advance_seconds(
        Math.max(
          LOGIN_BACKOFF_BOUNDS.max_delay_seconds,
          LOGIN_IP_RATE_LIMIT_BOUNDS.window_seconds,
        ) + 60,
      );

      const response_after_window_elapsed = await attempt_login(app, {
        email: VALID_LAWYER_EMAIL,
        password: VALID_LAWYER_PASSWORD,
      });

      expect(response_after_window_elapsed.status).toBe(200);
      expect(response_after_window_elapsed.headers['set-cookie']).toBeDefined();
    });
  });

  describe("[21bis] une reussite ne doit pas etre punie par les echecs d'un autre compte", () => {
    let integration_test_application: IntegrationTestApplication | undefined;
    let app: INestApplication;

    beforeAll(async () => {
      integration_test_application = await create_integration_test_application();
      app = integration_test_application.app;
    });

    afterAll(async () => {
      await close_integration_test_application(integration_test_application);
    });

    // ARBITRAGE OUVERT (voir rapport final) : la limite par IP protege contre
    // le contournement du test 19bis, mais un cabinet entier peut se
    // presenter derriere une seule IP publique. Ce test exprime l'intention
    // au plus pres sans trancher le seuil exact : une poignee d'echecs sur
    // un AUTRE compte, depuis la meme IP, ne doit pas transformer un poste
    // partage en deni de service permanent pour un avocat qui, lui, tape
    // les bons identifiants.
    it("[21bis] une tentative reussie n'est pas bloquee par le compteur d'echecs d'un autre compte partageant la meme IP, dans une mesure raisonnable", async () => {
      const other_account_email = 'cible-autre-compte-meme-ip@example.test';
      const reasonable_number_of_failures_from_a_shared_office =
        LOGIN_BACKOFF_BOUNDS.attempts_before_backoff;

      for (
        let attempt_index = 0;
        attempt_index < reasonable_number_of_failures_from_a_shared_office;
        attempt_index += 1
      ) {
        await attempt_login(app, wrong_password_attempt(other_account_email));
      }

      const successful_attempt_response = await attempt_login(app, {
        email: VALID_LAWYER_EMAIL,
        password: VALID_LAWYER_PASSWORD,
      });

      expect(successful_attempt_response.status).toBe(200);
    });
  });
});
