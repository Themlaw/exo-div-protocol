import {
  decide_login_throttle,
  decay_consecutive_failed_attempts,
  LOGIN_BACKOFF_BOUNDS,
  LOGIN_FAILURE_DECAY_SECONDS,
  LOGIN_IP_RATE_LIMIT_BOUNDS,
  type LoginThrottleOutcome,
  type LoginThrottleState,
} from '../../../src/auth/login_throttling';

// Un avocat qui vient de se tromper zero fois, depuis une adresse propre.
const QUIET_STATE: LoginThrottleState = {
  account_ip_failed_attempts: 0,
  seconds_since_account_ip_last_failure: 0,
  account_failed_attempts: 0,
  seconds_since_account_last_failure: 0,
  ip_failed_attempts_in_window: 0,
};

function state_with(overrides: Partial<LoginThrottleState>): LoginThrottleState {
  return { ...QUIET_STATE, ...overrides };
}

describe('[F1] le compteur par compte ne doit jamais pouvoir fermer le compte', () => {
  // LA faille remontee par la revue. Le seul compte avocat de l'installation
  // etait fermable pour toujours au prix de douze requetes puis d'une requete
  // toutes les cinq minutes : le compteur ne decroissait jamais et le delai
  // gatait aussi les identifiants corrects.
  it("un compte pilonne depuis une AUTRE adresse ne refuse jamais l'avocat legitime", () => {
    const legitimate_lawyer_on_a_clean_address: LoginThrottleState = state_with({
      // L'attaquant a accumule des centaines d'echecs sur ce compte...
      account_failed_attempts: 500,
      seconds_since_account_last_failure: 1,
      // ...mais depuis une autre adresse : le couple (compte, adresse) de
      // l'avocat est vierge.
      account_ip_failed_attempts: 0,
      ip_failed_attempts_in_window: 0,
    });

    const outcome: LoginThrottleOutcome = decide_login_throttle(
      legitimate_lawyer_on_a_clean_address,
    );

    expect(outcome.kind).not.toBe('refuse');
  });

  it("la couche par compte retarde mais ne refuse JAMAIS, quel que soit le nombre d'echecs", () => {
    const absurd_attempt_counts: readonly number[] = [
      LOGIN_BACKOFF_BOUNDS.attempts_before_backoff,
      50,
      5_000,
      Number.MAX_SAFE_INTEGER,
    ];

    for (const account_failed_attempts of absurd_attempt_counts) {
      const outcome: LoginThrottleOutcome = decide_login_throttle(
        state_with({ account_failed_attempts, seconds_since_account_last_failure: 0 }),
      );

      expect(outcome.kind).not.toBe('refuse');
    }
  });

  it("le delai de la couche par compte reste borne : un ralentissement infini serait un refus deguise", () => {
    const outcome: LoginThrottleOutcome = decide_login_throttle(
      state_with({ account_failed_attempts: 5_000, seconds_since_account_last_failure: 0 }),
    );

    if (outcome.kind !== 'delay') {
      throw new Error(`attendu un delai, recu ${outcome.kind}`);
    }
    expect(outcome.delay_seconds).toBeLessThanOrEqual(LOGIN_BACKOFF_BOUNDS.max_delay_seconds);
  });

  it("le couple (compte, adresse), lui, refuse : l'attaquant est sur son adresse, pas sur celle de la victime", () => {
    const outcome: LoginThrottleOutcome = decide_login_throttle(
      state_with({
        account_ip_failed_attempts: 50,
        seconds_since_account_ip_last_failure: 0,
      }),
    );

    expect(outcome.kind).toBe('refuse');
  });
});

describe('[F1] les compteurs decroissent avec le temps', () => {
  // Une echelle de backoff qui ne redescend jamais est un verrou permanent,
  // pas un ralentissement.
  it('apres un silence superieur a la fenetre de decroissance, le compteur repart de zero', () => {
    expect(
      decay_consecutive_failed_attempts(500, LOGIN_FAILURE_DECAY_SECONDS),
    ).toBe(0);
    expect(
      decay_consecutive_failed_attempts(500, LOGIN_FAILURE_DECAY_SECONDS + 1),
    ).toBe(0);
  });

  it('avant la fenetre, le compteur est conserve intact', () => {
    expect(
      decay_consecutive_failed_attempts(7, LOGIN_FAILURE_DECAY_SECONDS - 1),
    ).toBe(7);
  });

  it("une horloge qui recule ne fabrique pas d'echecs supplementaires", () => {
    expect(decay_consecutive_failed_attempts(7, -1_000)).toBe(7);
  });

  it("un compte pilonne puis laisse tranquille redevient utilisable sans intervention humaine", () => {
    const decayed: number = decay_consecutive_failed_attempts(
      500,
      LOGIN_FAILURE_DECAY_SECONDS,
    );

    const outcome: LoginThrottleOutcome = decide_login_throttle(
      state_with({
        account_failed_attempts: decayed,
        seconds_since_account_last_failure: LOGIN_FAILURE_DECAY_SECONDS,
      }),
    );

    expect(outcome).toEqual<LoginThrottleOutcome>({ kind: 'allow' });
  });
});

describe('la couche anti-balayage par adresse', () => {
  it('refuse au-dela du plafond par fenetre', () => {
    const outcome: LoginThrottleOutcome = decide_login_throttle(
      state_with({
        ip_failed_attempts_in_window:
          LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window,
      }),
    );

    expect(outcome.kind).toBe('refuse');
  });

  it('laisse passer en dessous du plafond : un cabinet entier partage une adresse publique', () => {
    const outcome: LoginThrottleOutcome = decide_login_throttle(
      state_with({
        ip_failed_attempts_in_window:
          LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window - 1,
      }),
    );

    expect(outcome.kind).not.toBe('refuse');
  });
});

describe("mode degrade : quand l'adresse client est invisible", () => {
  // Sur la VM d'exercice, le 443 est en passthrough SNI : toutes les requetes
  // partagent l'adresse du proxy frontal. Le couple (compte, adresse) s'effondre
  // alors sur la couche par compte, et c'est le « retarde sans refuser » qui
  // porte seul la securite. Ce test est la garantie que le mode degrade ne
  // ferme pas le portail.
  it("des centaines d'echecs sur le meme couple ne refusent pas si l'adresse est celle de tout le monde", () => {
    const everyone_shares_one_address: LoginThrottleState = state_with({
      account_failed_attempts: 500,
      seconds_since_account_last_failure: 0,
      account_ip_failed_attempts: 0,
      ip_failed_attempts_in_window: 0,
    });

    expect(decide_login_throttle(everyone_shares_one_address).kind).not.toBe('refuse');
  });
});

// Decide le 2026-09-09, apres etre tombe dessus au cablage HTTP : la decision
// ne regardait que le NOMBRE d'echecs, jamais le temps deja attendu. Un delai
// annonce `Retry-After: 1` durait donc en realite jusqu'a la decroissance, une
// heure plus tard. Trois fautes de frappe fermaient le poste de l'avocat pour
// l'apres-midi, et l'en-tete qu'on lui renvoyait etait faux.
describe('le backoff est une attente, pas un verrou : le temps deja ecoule compte', () => {
  it("une fois le delai annonce ecoule, le couple (compte, adresse) est de nouveau evalue", () => {
    const attempts_just_past_threshold: number =
      LOGIN_BACKOFF_BOUNDS.attempts_before_backoff;
    const announced_delay_seconds: number = LOGIN_BACKOFF_BOUNDS.initial_delay_seconds;

    expect(
      decide_login_throttle(
        state_with({
          account_ip_failed_attempts: attempts_just_past_threshold,
          seconds_since_account_ip_last_failure: announced_delay_seconds,
        }),
      ),
    ).toEqual<LoginThrottleOutcome>({ kind: 'allow' });
  });

  it("pendant le delai, le refus tient, et l'en-tete annonce le temps QUI RESTE", () => {
    const outcome: LoginThrottleOutcome = decide_login_throttle(
      state_with({
        account_ip_failed_attempts: LOGIN_BACKOFF_BOUNDS.attempts_before_backoff + 4,
        seconds_since_account_ip_last_failure: 6,
      }),
    );

    if (outcome.kind !== 'refuse') {
      throw new Error(`attendu un refus, recu ${outcome.kind}`);
    }
    // 2^4 = 16 secondes de backoff, dont 6 deja ecoulees.
    expect(outcome.retry_after_seconds).toBe(10);
  });

  it('la couche par compte suit la meme regle : elle ne retarde plus une fois le delai passe', () => {
    expect(
      decide_login_throttle(
        state_with({
          account_failed_attempts: LOGIN_BACKOFF_BOUNDS.attempts_before_backoff + 2,
          seconds_since_account_last_failure: LOGIN_BACKOFF_BOUNDS.max_delay_seconds,
        }),
      ),
    ).toEqual<LoginThrottleOutcome>({ kind: 'allow' });
  });

  it("le plafond de delai reste un plafond d'ATTENTE : au-dela, la tentative repasse", () => {
    expect(
      decide_login_throttle(
        state_with({
          account_ip_failed_attempts: 5_000,
          seconds_since_account_ip_last_failure:
            LOGIN_BACKOFF_BOUNDS.max_delay_seconds + 1,
        }),
      ),
    ).toEqual<LoginThrottleOutcome>({ kind: 'allow' });
  });
});
