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
  LOGIN_FAILURE_DECAY_SECONDS,
  LOGIN_IP_RATE_LIMIT_BOUNDS,
} from '../../../src/auth/login_throttling';
import { LAWYER_AUTH_ROUTE_PATHS } from '../../../src/auth/auth_http_contract';

// BetterAuth monte ses propres routes sous /api/v1/auth/* : il n'existe pas de
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

// Tests issus de la revue de securite du 2026-09-08. Chacun rejoue une faille
// au niveau HTTP, la ou les tests precedents ne l'auraient pas vue.
// SEUL bloc a declarer un relais de confiance, et il le doit : il distingue
// l'attaquant de l'avocat PAR l'adresse transmise, ce qui n'a de sens que
// derriere notre Traefik, la ou la derniere entree de la chaine est ecrite par
// un relais et non par le client. Les autres blocs restent en mode degrade
// (passthrough SNI, en-tete ignore) — c'est la que [20] prouve qu'un
// X-Forwarded-For forge ne rend aucun budget de tentatives.
const TRUSTED_PROXY_HOP_COUNT_BEHIND_TRAEFIK = 1;

describe('[F1] le pilonnage d un compte ne doit pas fermer ce compte', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;

  const ATTACKER_ADDRESS = '203.0.113.66';
  const LAWYER_ADDRESS = '198.51.100.12';

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application({
      trusted_proxy_hop_count: TRUSTED_PROXY_HOP_COUNT_BEHIND_TRAEFIK,
    });
    app = integration_test_application.app;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it("un attaquant qui pilonne depuis son adresse ne verrouille pas l'avocat qui se connecte depuis la sienne", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await attempt_login(app, wrong_password_attempt(VALID_LAWYER_EMAIL), {
        'x-forwarded-for': ATTACKER_ADDRESS,
      });
    }

    const lawyer_response = await attempt_login(
      app,
      { email: VALID_LAWYER_EMAIL, password: VALID_LAWYER_PASSWORD },
      { 'x-forwarded-for': LAWYER_ADDRESS },
    );

    expect(lawyer_response.status).toBe(200);
  });

  it("meme depuis l'adresse pilonnee, des identifiants corrects finissent par passer : la couche par compte retarde, elle ne ferme pas", async () => {
    const clock = build_mutable_test_clock(new Date('2026-03-12T10:00:00.000Z'));
    const application_with_clock = await create_integration_test_application({
      clock,
      trusted_proxy_hop_count: TRUSTED_PROXY_HOP_COUNT_BEHIND_TRAEFIK,
    });

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await attempt_login(
          application_with_clock.app,
          wrong_password_attempt(VALID_LAWYER_EMAIL),
          { 'x-forwarded-for': ATTACKER_ADDRESS },
        );
      }

      // Le temps passe sans nouvelle tentative : les compteurs decroissent.
      clock.advance_seconds(LOGIN_FAILURE_DECAY_SECONDS + 1);

      const response = await attempt_login(
        application_with_clock.app,
        { email: VALID_LAWYER_EMAIL, password: VALID_LAWYER_PASSWORD },
        { 'x-forwarded-for': ATTACKER_ADDRESS },
      );

      expect(response.status).toBe(200);
    } finally {
      await close_integration_test_application(application_with_clock);
    }
  });
});

describe('[F2] un email demesure ne doit ni coûter un Argon2 gratuit, ni echapper au comptage', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  const OVERSIZED_EMAIL = `${'a'.repeat(100_000)}@example.test`;

  it("un email de 100 000 caracteres est rejete sans erreur 500 : sinon l'INSERT du compteur viole le CHECK", async () => {
    const response = await attempt_login(app, {
      email: OVERSIZED_EMAIL,
      password: 'peu-importe-le-mot-de-passe',
    });

    expect(response.status).toBeLessThan(500);
  });

  it("un email demesure ne declenche AUCUN hachage : sinon l'attaquant fait payer un Argon2 par requete", async () => {
    const calls_before = integration_test_application!.password_hashing_call_count();

    await attempt_login(app, {
      email: OVERSIZED_EMAIL,
      password: 'peu-importe-le-mot-de-passe',
    });

    expect(integration_test_application!.password_hashing_call_count()).toBe(calls_before);
  });

  it.each([
    ['un email sans arobase', 'pas-une-adresse'],
    ['un email avec un espace', 'de mo@example.test'],
    ['un email vide', ''],
  ])('%s est rejete sans erreur 500', async (_label: string, email: string) => {
    const response = await attempt_login(app, { email, password: 'peu-importe' });

    expect(response.status).toBeLessThan(500);
  });
});

describe('[F3] les variantes de casse et d espaces partagent un seul compteur', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it("alterner la casse ne rend pas un budget de tentatives neuf", async () => {
    const case_variants: readonly string[] = [
      VALID_LAWYER_EMAIL,
      VALID_LAWYER_EMAIL.toUpperCase(),
      `  ${VALID_LAWYER_EMAIL}  `,
      VALID_LAWYER_EMAIL.replace('@', '@'),
    ];

    let last_response: request.Response | undefined;
    for (let round = 0; round < 6; round += 1) {
      for (const email_variant of case_variants) {
        last_response = await attempt_login(app, wrong_password_attempt(email_variant), {
          'x-forwarded-for': '203.0.113.77',
        });
      }
    }

    expect(last_response).toBeDefined();
    expect(was_slowed_or_refused(last_response!)).toBe(true);
  });
});

// [F10] Le test [18] acceptait la simple presence d'un en-tete Retry-After :
// une implementation qui renvoie `Retry-After: 0` partout le passait sans
// ralentir quoi que ce soit.
describe('[F10] le ralentissement doit etre observable, pas seulement annonce', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('le delai annonce croit avec les echecs, et n est jamais nul une fois le seuil franchi', async () => {
    const announced_delays: number[] = [];
    const targeted_address = '203.0.113.88';

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await attempt_login(app, wrong_password_attempt(VALID_LAWYER_EMAIL), {
        'x-forwarded-for': targeted_address,
      });
      const retry_after = response.headers['retry-after'];
      if (retry_after !== undefined) {
        announced_delays.push(Number(retry_after));
      }
    }

    expect(announced_delays.length).toBeGreaterThan(0);
    for (const delay of announced_delays) {
      expect(delay).toBeGreaterThan(0);
    }
    expect(announced_delays[announced_delays.length - 1]).toBeGreaterThan(announced_delays[0]!);
  });

  it('le delai reste borne par le plafond : un ralentissement infini serait un refus deguise', async () => {
    const targeted_address = '203.0.113.99';
    let last_retry_after: string | undefined;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await attempt_login(app, wrong_password_attempt(VALID_LAWYER_EMAIL), {
        'x-forwarded-for': targeted_address,
      });
      last_retry_after = response.headers['retry-after'] ?? last_retry_after;
    }

    expect(Number(last_retry_after)).toBeLessThanOrEqual(
      LOGIN_BACKOFF_BOUNDS.max_delay_seconds,
    );
  });
});
