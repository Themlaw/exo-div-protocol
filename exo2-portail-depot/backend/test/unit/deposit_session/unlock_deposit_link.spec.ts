import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';
import {
  CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS,
  DepositLinkUnlockService,
  type DepositLinkUnlockOutcome,
} from '../../../src/deposit_session/unlock_deposit_link';
import { CLIENT_PIN_IP_RATE_LIMIT_BOUNDS } from '../../../src/deposit_session/client_pin_throttle_store';
import type {
  ClientPinThrottleStore,
} from '../../../src/deposit_session/client_pin_throttle_store';
import type {
  DepositSessionRepository,
  OpenedDepositSession,
} from '../../../src/deposit_session/deposit_session_repository';
import type { AccessLinkRepository } from '../../../src/access_link/access_link_repository';
import type { AccessLink } from '../../../src/domain/access_link';
import type { PinHasher } from '../../../src/domain/verify_client_pin';
import type { DepositSession } from '../../../src/domain/deposit_session';
import type { NewActivityEvent } from '../../../src/domain/activity_event';
import { build_access_link, REFERENCE_NOW } from '../../fixtures/domain_builders';

const CLIENT_IP = '203.0.113.7';

interface UnlockHarness {
  service: DepositLinkUnlockService;
  hashing_call_count: () => number;
  recorded_failure_count: () => number;
  saved_attempt_count: () => number;
  opened_session_count: () => number;
  activity_events: FakeActivityEventRepository;
  logger: CapturingLogger;
}

function build_unlock_harness(options: {
  link: AccessLink | null;
  pin_is_correct?: boolean;
  recent_ip_failures?: number;
  attempt_is_recorded?: boolean;
}): UnlockHarness {
  let hashing_call_count = 0;
  let recorded_failure_count = 0;
  let saved_attempt_count = 0;
  let opened_session_count = 0;
  const activity_events = new FakeActivityEventRepository();
  const logger: CapturingLogger = build_capturing_logger();

  const pin_hasher: PinHasher = {
    hash: async (): Promise<string> => {
      hashing_call_count += 1;
      return 'hachage-du-pin';
    },
    verify: async (): Promise<boolean> => {
      hashing_call_count += 1;
      return options.pin_is_correct === true;
    },
  };

  const access_links: AccessLinkRepository = {
    confirms_deposit_request_ownership: async (): Promise<boolean> => true,
    issue_link_replacing_current: async (): Promise<AccessLink | null> => null,
    find_by_token_hmac: async (): Promise<AccessLink | null> => options.link,
    save_attempt_outcome: async (): Promise<boolean> => {
      saved_attempt_count += 1;
      return options.attempt_is_recorded !== false;
    },
    revoke_current_link: async (): Promise<string | null> => 'link-revoque',
  };

  const deposit_sessions: DepositSessionRepository = {
    open_session: async (input: {
      session: Omit<DepositSession, 'id'>;
      token_sha256: string;
    }): Promise<DepositSession> => {
      opened_session_count += 1;
      return { id: 'session-1', ...input.session };
    },
    find_by_token_fingerprint: async (): Promise<OpenedDepositSession | null> => null,
    consume_upload_allowance: async (): Promise<boolean> => true,
  };

  const throttle_store: ClientPinThrottleStore = {
    count_recent_failures: async (): Promise<number> => options.recent_ip_failures ?? 0,
    record_failure: async (): Promise<void> => {
      recorded_failure_count += 1;
    },
  };

  return {
    service: new DepositLinkUnlockService({
      access_links,
      activity_events,
      deposit_sessions,
      token_hasher: {
        fingerprint_token: (token: string) => ({
          token_hmac: `hmac-de-${token}`,
          token_pepper_version: 1,
        }),
      },
      pin_hasher,
      throttle_store,
      clock: { now: (): Date => REFERENCE_NOW },
      random_source: { bytes: (length: number): Buffer => Buffer.alloc(length, 3) },
      logger,
    }),
    hashing_call_count: (): number => hashing_call_count,
    recorded_failure_count: (): number => recorded_failure_count,
    saved_attempt_count: (): number => saved_attempt_count,
    opened_session_count: (): number => opened_session_count,
    activity_events,
    logger,
  };
}

function unlock_with(harness: UnlockHarness, submitted_pin = '1234'): Promise<DepositLinkUnlockOutcome> {
  return harness.service.unlock({ token: 'un-jeton', submitted_pin, client_ip: CLIENT_IP });
}

describe('DepositLinkUnlockService', () => {
  // La propriete qui distingue cette route de la connexion avocat : un anonyme
  // ne doit pas pouvoir bruler les places du portillon argon2 avec des jetons
  // inventes. L'echec est quand meme compte, sans quoi balayer serait gratuit.
  it('ne hache rien sur un jeton inconnu, mais compte quand meme l echec', async () => {
    const harness = build_unlock_harness({ link: null });

    await expect(unlock_with(harness)).resolves.toEqual({ kind: 'refused' });

    expect(harness.hashing_call_count()).toBe(0);
    expect(harness.saved_attempt_count()).toBe(0);
    expect(harness.recorded_failure_count()).toBe(1);
  });

  // Un lien deja bloque ne consomme AUCUN essai : sinon n'importe qui pourrait
  // maintenir le compteur au plafond, et le journal d'audit confondrait
  // l'attaque initiale avec le bruit qui la suit.
  it('ne hache rien et ne consomme aucun essai sur un lien deja bloque', async () => {
    const harness = build_unlock_harness({ link: build_access_link({ status: 'blocked' }) });

    await expect(unlock_with(harness)).resolves.toEqual({ kind: 'blocked' });

    expect(harness.hashing_call_count()).toBe(0);
    expect(harness.saved_attempt_count()).toBe(0);
  });

  // Un lien expire ou revoque est deja mort : le hacher paierait un travail que
  // le resultat ne peut plus rendre utile.
  it.each([
    ['revoque', build_access_link({ status: 'revoked', revoked_at: REFERENCE_NOW })],
    ['expire', build_access_link({ expires_at: new Date(REFERENCE_NOW.getTime() - 1) })],
  ])('ne hache rien sur un lien %s et rend le refus generique', async (_label, link) => {
    const harness = build_unlock_harness({ link });

    await expect(unlock_with(harness)).resolves.toEqual({ kind: 'refused' });

    expect(harness.hashing_call_count()).toBe(0);
    expect(harness.recorded_failure_count()).toBe(1);
  });

  it('refuse sans hacher des que le budget de l adresse est epuise', async () => {
    const harness = build_unlock_harness({
      link: build_access_link(),
      pin_is_correct: true,
      recent_ip_failures: CLIENT_PIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window,
    });

    await expect(unlock_with(harness)).resolves.toEqual({ kind: 'rate_limited' });

    expect(harness.hashing_call_count()).toBe(0);
    expect(harness.opened_session_count()).toBe(0);
  });

  // Le mode degrade du passthrough SNI : sans adresse exploitable la couche par
  // IP s'efface, et le plafond par lien — la vraie protection — reste seul.
  it('ouvre quand meme la session quand aucune adresse ne peut etre etablie', async () => {
    const harness = build_unlock_harness({ link: build_access_link(), pin_is_correct: true });

    const outcome = await harness.service.unlock({
      token: 'un-jeton',
      submitted_pin: '1234',
      client_ip: null,
    });

    expect(outcome.kind).toBe('unlocked');
    expect(harness.recorded_failure_count()).toBe(0);
  });

  it('ouvre une session bornee par la duree de vie decidee, et rend un jeton', async () => {
    const harness = build_unlock_harness({ link: build_access_link(), pin_is_correct: true });

    const outcome = await unlock_with(harness);

    expect(outcome.kind).toBe('unlocked');
    if (outcome.kind !== 'unlocked') {
      return;
    }
    expect(outcome.session_token).toHaveLength(32);
    expect(outcome.expires_at.getTime()).toBe(
      REFERENCE_NOW.getTime() + CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS * 1000,
    );
    expect(harness.opened_session_count()).toBe(1);
  });

  // La course perdue sur la garde optimiste : une autre requete a ecrit entre
  // notre lecture et notre ecriture. Accorder sur un etat perime reviendrait a
  // ignorer le plafond qu'elle vient peut-etre d'atteindre.
  it('n ouvre rien quand la garde optimiste refuse l ecriture, meme avec le bon PIN', async () => {
    const harness = build_unlock_harness({
      link: build_access_link(),
      pin_is_correct: true,
      attempt_is_recorded: false,
    });

    await expect(unlock_with(harness)).resolves.toEqual({ kind: 'refused' });

    expect(harness.opened_session_count()).toBe(0);
  });

  // Le dernier essai perdu est le seul refus qui s'annonce : le client doit
  // comprendre qu'il lui faut un nouveau lien, pas qu'il a mal recopie.
  it('annonce le blocage sur l essai qui atteint le plafond', async () => {
    const harness = build_unlock_harness({
      link: build_access_link({ max_pin_attempts: 5, failed_pin_attempts: 4 }),
      pin_is_correct: false,
    });

    await expect(unlock_with(harness)).resolves.toEqual({ kind: 'blocked' });
  });

  it('rend le refus generique sur un essai perdu qui ne bloque pas encore', async () => {
    const harness = build_unlock_harness({
      link: build_access_link({ max_pin_attempts: 5, failed_pin_attempts: 1 }),
      pin_is_correct: false,
    });

    await expect(unlock_with(harness)).resolves.toEqual({ kind: 'refused' });
  });

  it('journalise le PIN refuse avec l adresse du client', async () => {
    const link: AccessLink = build_access_link({ max_pin_attempts: 5, failed_pin_attempts: 1 });
    const harness = build_unlock_harness({ link, pin_is_correct: false });

    await unlock_with(harness);

    expect(harness.activity_events.recorded_events).toEqual<NewActivityEvent[]>([
      {
        deposit_request_id: link.deposit_request_id,
        type: 'client_pin_rejected',
        actor: { kind: 'client' },
        access_link_id: link.id,
        deposited_file_id: null,
        client_ip: CLIENT_IP,
        occurred_at: REFERENCE_NOW,
      },
    ]);
  });

  // L'essai perdu vient AVANT le basculement : c'est lui qui le provoque, et
  // l'ordre inverse raconterait un lien bloque sans cause.
  it('journalise l essai perdu puis le blocage, dans cet ordre, sur l essai qui atteint le plafond', async () => {
    const harness = build_unlock_harness({
      link: build_access_link({ max_pin_attempts: 5, failed_pin_attempts: 4 }),
      pin_is_correct: false,
    });

    await unlock_with(harness);

    expect(harness.activity_events.recorded_types()).toEqual([
      'client_pin_rejected',
      'access_link_blocked',
    ]);
  });

  // Le journal raconte le BASCULEMENT, pas l etat : sans cela, marteler un lien
  // deja bloque ferait autant d evenements de blocage que d essais.
  // Chaque essai sur un lien verrouille est un fait distinct : c'est ce qui
  // explique a l'avocat pourquoi son client n'a jamais rien depose. Ce n'est
  // PAS un `access_link_blocked`, qui date le basculement et n'arrive qu'une
  // fois.
  it('journalise chaque tentative visant un lien deja bloque', async () => {
    const link: AccessLink = build_access_link({ status: 'blocked' });
    const harness = build_unlock_harness({ link });

    await unlock_with(harness);
    await unlock_with(harness);

    expect(harness.activity_events.recorded_types()).toEqual([
      'unusable_access_link_attempted',
      'unusable_access_link_attempted',
    ]);
    expect(harness.activity_events.recorded_events[0]).toMatchObject({
      access_link_id: link.id,
      client_ip: CLIENT_IP,
    });
  });

  it('journalise l ouverture de session avec l adresse du client sur un deverrouillage reussi', async () => {
    const link: AccessLink = build_access_link();
    const harness = build_unlock_harness({ link, pin_is_correct: true });

    await unlock_with(harness);

    expect(harness.activity_events.recorded_events).toEqual<NewActivityEvent[]>([
      {
        deposit_request_id: link.deposit_request_id,
        type: 'deposit_session_opened',
        actor: { kind: 'client' },
        access_link_id: link.id,
        deposited_file_id: null,
        client_ip: CLIENT_IP,
        occurred_at: REFERENCE_NOW,
      },
    ]);
  });

  // Un token inconnu ne designe aucune demande : il n existe aucun journal ou
  // l inscrire. C est le compteur par adresse qui porte la detection de balayage.
  it('ne journalise rien sur un jeton inconnu', async () => {
    const harness = build_unlock_harness({ link: null });

    await unlock_with(harness);

    expect(harness.activity_events.recorded_types()).toEqual([]);
  });

  // La tentative EST inscrite — elle a eu lieu, et elle explique pourquoi rien
  // n'a ete depose — mais pas comme un PIN refuse : aucun code n'a ete verifie
  // sur un lien mort, et l'ecrire affirmerait une tentative qui n'a pas eu lieu.
  it.each([
    ['revoque', build_access_link({ status: 'revoked', revoked_at: REFERENCE_NOW })],
    ['expire', build_access_link({ expires_at: new Date(REFERENCE_NOW.getTime() - 1) })],
  ])('journalise la tentative sur un lien %s sans inventer de PIN refuse', async (_label, link) => {
    const harness = build_unlock_harness({ link });

    await unlock_with(harness);

    expect(harness.activity_events.recorded_types()).toEqual([
      'unusable_access_link_attempted',
    ]);
  });

  it('ne journalise rien quand la limitation par adresse refuse la tentative', async () => {
    const harness = build_unlock_harness({
      link: build_access_link(),
      pin_is_correct: true,
      recent_ip_failures: CLIENT_PIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window,
    });

    await unlock_with(harness);

    expect(harness.activity_events.recorded_types()).toEqual([]);
  });
});
