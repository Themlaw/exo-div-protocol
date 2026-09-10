import {
  bootstrap_demo_deposit_request,
  DEMO_DEPOSIT_REQUEST,
  type DemoAccessLinkRepository,
  type DemoAccessLinkSeed,
  type DemoDepositRequestRepository,
} from '../../../src/deposit/demo_deposit_request_bootstrap';
import { validate_deposit_request_creation } from '../../../src/domain/expected_document';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import type { AccessLink } from '../../../src/domain/access_link';
import type { AccessLinkIssuance } from '../../../src/access_link/access_link_repository';
import type { AccessLinkTokenHasher } from '../../../src/access_link/access_link_token_hasher';
import type { PinHasher } from '../../../src/domain/verify_client_pin';
import type { DemoActivityEventRecorder } from '../../../src/deposit/demo_deposit_request_bootstrap';
import type { NewActivityEvent } from '../../../src/domain/activity_event';
import type { Clock } from '../../../src/shared/clock';

const AN_OWNER_USER_ID = 'e0e3f9f2-1a4b-4c3d-8e5f-6a7b8c9d0e1f';
const A_CREATED_DEPOSIT_REQUEST_ID = 'un-identifiant';
const AN_ISSUED_ACCESS_LINK_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const THE_BOOTSTRAP_INSTANT = new Date('2026-03-01T09:00:00.000Z');

// Le couple publie dans le README et affiche par `install.sh`.
const A_DEMO_ACCESS_LINK_SEED: DemoAccessLinkSeed = {
  token: 'aaaabbbbccccddddeeeeffffgggghhhh',
  pin: '314159',
};

// Des empreintes LISIBLES, qui reportent leur entree : c'est ce qui permet
// d'affirmer que c'est bien le jeton publie qui a ete empreinte, et bien le PIN
// publie qui a ete hache — et non deux secrets tires au hasard.
function build_token_hasher(): AccessLinkTokenHasher {
  return {
    fingerprint_token: (token: string) => ({
      token_hmac: `hmac(${token})`,
      token_pepper_version: 1,
    }),
  };
}

function build_pin_hasher(): PinHasher {
  return {
    hash: async (pin: string): Promise<string> => `argon2(${pin})`,
    verify: async (pin: string, pin_hash: string): Promise<boolean> =>
      pin_hash === `argon2(${pin})`,
  };
}

function build_access_link_repository(): DemoAccessLinkRepository & {
  issuances: AccessLinkIssuance[];
} {
  const issuances: AccessLinkIssuance[] = [];

  return {
    issuances,
    issue_link_replacing_current: async (input): Promise<AccessLink | null> => {
      issuances.push(input.issuance);

      return {
        id: AN_ISSUED_ACCESS_LINK_ID,
        deposit_request_id: input.deposit_request_id,
        token_hmac: input.issuance.token_hmac,
        token_pepper_version: input.issuance.token_pepper_version,
        pin_hash: input.issuance.pin_hash,
        pin_length: input.issuance.security_policy.pin_length,
        max_pin_attempts: input.issuance.security_policy.max_pin_attempts,
        failed_pin_attempts: 0,
        status: 'active',
        expires_at: input.issuance.expires_at,
        created_at: input.now,
        blocked_at: null,
        revoked_at: null,
      };
    },
  };
}

function build_activity_events(): DemoActivityEventRecorder & { recorded: NewActivityEvent[] } {
  const recorded: NewActivityEvent[] = [];

  return {
    recorded,
    record: async (event: NewActivityEvent): Promise<void> => {
      recorded.push(event);
    },
  };
}

function build_bootstrap_dependencies(existing_request_count: number) {
  return {
    deposit_requests: build_repository(existing_request_count),
    access_links: build_access_link_repository(),
    token_hasher: build_token_hasher(),
    pin_hasher: build_pin_hasher(),
    activity_events: build_activity_events(),
    clock: { now: (): Date => THE_BOOTSTRAP_INSTANT } satisfies Clock,
  };
}

function build_repository(existing_request_count: number): DemoDepositRequestRepository & {
  created_inputs: unknown[];
} {
  const created_inputs: unknown[] = [];

  return {
    created_inputs,
    count_for_owner: async (): Promise<number> => existing_request_count,
    create: async (input): Promise<string> => {
      created_inputs.push(input);
      return 'un-identifiant';
    },
  };
}

describe('bootstrap_demo_deposit_request', () => {
  it('cree la demande de demonstration sur une base vierge', async () => {
    // L'enonce demande « au moins une demande seedee » : sans elle, l'evaluateur
    // qui se connecte tombe sur une liste vide et doit deviner par ou commencer.
    const dependencies = build_bootstrap_dependencies(0);

    const outcome = await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID, access_link_seed: A_DEMO_ACCESS_LINK_SEED },
      dependencies,
    );

    expect(outcome.deposit_request_was_created).toBe(true);
    expect(dependencies.deposit_requests.created_inputs).toEqual([
      {
        owner_user_id: AN_OWNER_USER_ID,
        creation: DEMO_DEPOSIT_REQUEST,
        security_policy: DEFAULT_SECURITY_POLICY,
      },
    ]);
  });

  it('ne cree rien si l avocat a deja une demande', async () => {
    // L'amorcage tourne a CHAQUE demarrage. Sans ce garde, chaque redemarrage
    // ajouterait une demande, et un conteneur qui redemarre en boucle noierait
    // le vrai travail de l'avocat sous des demandes de demonstration.
    const dependencies = build_bootstrap_dependencies(1);

    const outcome = await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID, access_link_seed: A_DEMO_ACCESS_LINK_SEED },
      dependencies,
    );

    expect(outcome).toEqual({
      deposit_request_was_created: false,
      access_link_was_issued: false,
    });
    expect(dependencies.deposit_requests.created_inputs).toHaveLength(0);
    // Et surtout AUCUN lien : reemettre le lien publie a chaque demarrage
    // remettrait a zero le compteur de tentatives d'une demande bien reelle,
    // et rouvrirait un lien que l'avocat vient peut-etre de revoquer.
    expect(dependencies.access_links.issuances).toHaveLength(0);
  });

  it('la demande de demonstration est une demande VALIDE', async () => {
    // Elle passe par les memes regles que celle d'un avocat : une demande seedee
    // que le formulaire aurait refusee serait une demonstration de ce que le
    // produit ne sait pas faire.
    expect(validate_deposit_request_creation(DEMO_DEPOSIT_REQUEST)).toEqual([]);
  });

  it('la demande de demonstration montre plusieurs emplacements et plusieurs types', async () => {
    // Un seul emplacement PDF ne montrerait ni la numerotation, ni le fait que
    // chaque emplacement porte ses propres contraintes.
    expect(DEMO_DEPOSIT_REQUEST.expected_documents.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(DEMO_DEPOSIT_REQUEST.expected_documents.flatMap((document) => document.allowed_mime_types))
        .size,
    ).toBeGreaterThanOrEqual(2);
  });
  it('emet le lien de demonstration avec le jeton et le PIN publies', async () => {
    // Le README et la sortie de `install.sh` annoncent un lien et un code precis.
    // L'evaluateur les recopie tels quels : si l'amorcage tirait ses propres
    // secrets, le lien publie n'ouvrirait rien et la demonstration commencerait
    // par un echec.
    const dependencies = build_bootstrap_dependencies(0);

    const outcome = await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID, access_link_seed: A_DEMO_ACCESS_LINK_SEED },
      dependencies,
    );

    expect(outcome.access_link_was_issued).toBe(true);
    expect(dependencies.access_links.issuances).toEqual([
      {
        token_hmac: `hmac(${A_DEMO_ACCESS_LINK_SEED.token})`,
        token_pepper_version: 1,
        pin_hash: `argon2(${A_DEMO_ACCESS_LINK_SEED.pin})`,
        security_policy: DEFAULT_SECURITY_POLICY,
        expires_at: new Date(
          THE_BOOTSTRAP_INSTANT.getTime() +
            DEFAULT_SECURITY_POLICY.link_lifetime_days * 24 * 60 * 60 * 1000,
        ),
      },
    ]);
  });

  it('rattache le lien a la demande qui vient d etre creee', async () => {
    const dependencies = build_bootstrap_dependencies(0);
    let lien_rattache_a: string | null = null;
    const emission = dependencies.access_links.issue_link_replacing_current.bind(
      dependencies.access_links,
    );
    dependencies.access_links.issue_link_replacing_current = async (input) => {
      lien_rattache_a = input.deposit_request_id;
      return emission(input);
    };

    await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID, access_link_seed: A_DEMO_ACCESS_LINK_SEED },
      dependencies,
    );

    expect(lien_rattache_a).toBe(A_CREATED_DEPOSIT_REQUEST_ID);
  });

  it('journalise l emission comme n importe quelle autre', async () => {
    // Le tableau de bord de la demande seedee doit raconter la meme histoire que
    // celui d'une vraie : sans cet evenement, l'evaluateur ouvre une demande dont
    // le journal est vide alors qu'un lien existe.
    const dependencies = build_bootstrap_dependencies(0);

    await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID, access_link_seed: A_DEMO_ACCESS_LINK_SEED },
      dependencies,
    );

    expect(dependencies.activity_events.recorded).toEqual([
      expect.objectContaining({
        deposit_request_id: A_CREATED_DEPOSIT_REQUEST_ID,
        type: 'access_link_issued',
        actor: { kind: 'lawyer', user_id: AN_OWNER_USER_ID },
        access_link_id: AN_ISSUED_ACCESS_LINK_ID,
        occurred_at: THE_BOOTSTRAP_INSTANT,
      }),
    ]);
  });

  it('rend compte du lien non emis quand l ecriture le refuse', async () => {
    // La demande existe alors, mais sans lien. Le dire plutot que de laisser
    // croire a un amorcage complet : c'est cette valeur qui decide du message
    // affiche au demarrage.
    const dependencies = build_bootstrap_dependencies(0);
    dependencies.access_links.issue_link_replacing_current = async (): Promise<null> => null;

    const outcome = await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID, access_link_seed: A_DEMO_ACCESS_LINK_SEED },
      dependencies,
    );

    expect(outcome).toEqual({
      deposit_request_was_created: true,
      access_link_was_issued: false,
    });
    expect(dependencies.activity_events.recorded).toHaveLength(0);
  });
});
