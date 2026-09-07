import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { verify_client_pin, type PinHasher } from '../../../src/domain/verify_client_pin';
import type { AccessLink } from '../../../src/domain/access_link';
import {
  apply_deposit_request_user_action,
  apply_deposit_request_pipeline_event,
  ForbiddenDepositRequestTransitionError,
  type DepositRequestStatus,
  type DepositRequestUserAction,
  type DepositRequestPipelineEvent,
} from '../../../src/domain/deposit_request_status';
import {
  build_access_link,
  add_days,
  REFERENCE_NOW,
} from '../../fixtures/domain_builders';

// Seed et numRuns fixes explicitement : une seed variable rendrait un echec
// irreproductible et laisserait un test passer par pure chance du generateur.
const FAST_CHECK_OPTIONS = { seed: 42, numRuns: 500 };

const REFERENCE_PIN = '4821';

// SHA-256 plutot qu'argon2 : on ne veut pas mesurer le cout d'argon2 ici, et
// 500 runs de fast-check sur un hachage calibre a 400 ms ne finiraient jamais.
// SHA-256 donne une valeur opaque, deterministe et de forme credible, qui surtout
// ne contient pas le PIN — un `fake-hash-of-${pin}` ferait echouer un test de
// non-fuite sur une implementation pourtant correcte.
function build_fake_pin_hasher(): PinHasher {
  return {
    hash: async (pin: string): Promise<string> =>
      createHash('sha256').update(pin).digest('hex'),
    verify: async (pin: string): Promise<boolean> => pin === REFERENCE_PIN,
  };
}

const VALID_DEPOSIT_REQUEST_STATUSES: DepositRequestStatus[] = [
  'incomplete',
  'processing',
  'validated',
  'blocked',
  'expired_incomplete',
];

const ALL_DEPOSIT_REQUEST_PIPELINE_EVENTS: DepositRequestPipelineEvent[] = [
  'all_expected_documents_clean',
  'expected_document_became_not_clean',
  'access_link_blocked',
  'access_link_expired',
];

const ALL_DEPOSIT_REQUEST_USER_ACTIONS: DepositRequestUserAction[] = ['client_finished_deposit'];

describe('proprietes du domaine (fast-check)', () => {
  it("[33] un lien expire n'accorde jamais l'accès, quelle que soit la séquence de PIN soumis", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }),
        async (submitted_pins) => {
          const expired_link: AccessLink = build_access_link({
            expires_at: add_days(REFERENCE_NOW, -1),
          });
          const pin_hasher = build_fake_pin_hasher();
          const now = REFERENCE_NOW;

          let current_link = expired_link;
          for (const submitted_pin of submitted_pins) {
            const outcome = await verify_client_pin(current_link, submitted_pin, now, {
              pin_hasher,
            });
            expect(outcome.granted).toBe(false);
            current_link = outcome.link_after_attempt;
          }
        },
      ),
      FAST_CHECK_OPTIONS,
    );
  });

  it("[34] failed_pin_attempts ne décroît jamais, sauf exactement quand granted vaut true (où il repart à zéro)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }),
        async (submitted_pins) => {
          const pin_hasher = build_fake_pin_hasher();
          const now = REFERENCE_NOW;
          let current_link: AccessLink = build_access_link({ pin_length: REFERENCE_PIN.length });

          for (const submitted_pin of submitted_pins) {
            const attempts_before = current_link.failed_pin_attempts;
            const outcome = await verify_client_pin(current_link, submitted_pin, now, {
              pin_hasher,
            });
            const attempts_after = outcome.link_after_attempt.failed_pin_attempts;

            if (outcome.granted) {
              expect(attempts_after).toBe(0);
            } else {
              expect(attempts_after).toBeGreaterThanOrEqual(attempts_before);
            }

            current_link = outcome.link_after_attempt;
          }
        },
      ),
      FAST_CHECK_OPTIONS,
    );
  });

  it('[34 bis] failed_pin_attempts ne dépasse jamais max_pin_attempts, quelle que soit la séquence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 30 }),
        async (submitted_pins) => {
          const pin_hasher = build_fake_pin_hasher();
          const now = REFERENCE_NOW;
          let current_link: AccessLink = build_access_link({ pin_length: REFERENCE_PIN.length });

          for (const submitted_pin of submitted_pins) {
            const outcome = await verify_client_pin(current_link, submitted_pin, now, {
              pin_hasher,
            });
            current_link = outcome.link_after_attempt;
            expect(current_link.failed_pin_attempts).toBeLessThanOrEqual(
              current_link.max_pin_attempts,
            );
          }
        },
      ),
      FAST_CHECK_OPTIONS,
    );
  });

  it("[35] toute séquence de DepositRequestPipelineEvent reste dans les statuts valides et ne leve jamais : c'est l'invariant qui protege le worker de scan, qui recoit les evenements dans un ordre non maitrise", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_DEPOSIT_REQUEST_STATUSES),
        fc.array(fc.constantFrom(...ALL_DEPOSIT_REQUEST_PIPELINE_EVENTS), { maxLength: 30 }),
        (initial_status, events) => {
          let current_status = initial_status;

          for (const event of events) {
            expect(() => apply_deposit_request_pipeline_event(current_status, event)).not.toThrow();
            current_status = apply_deposit_request_pipeline_event(current_status, event);
            expect(VALID_DEPOSIT_REQUEST_STATUSES).toContain(current_status);
          }
        },
      ),
      FAST_CHECK_OPTIONS,
    );
  });

  it('[35] toute séquence de DepositRequestUserAction reste dans les statuts valides, et toute erreur levée est une ForbiddenDepositRequestTransitionError', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_DEPOSIT_REQUEST_STATUSES),
        fc.array(fc.constantFrom(...ALL_DEPOSIT_REQUEST_USER_ACTIONS), { maxLength: 30 }),
        (initial_status, actions) => {
          let current_status = initial_status;

          for (const action of actions) {
            try {
              current_status = apply_deposit_request_user_action(current_status, action);
              expect(VALID_DEPOSIT_REQUEST_STATUSES).toContain(current_status);
            } catch (error) {
              // Une action interdite n'altère jamais l'état courant : la
              // séquence continue avec le statut inchangé.
              expect(error).toBeInstanceOf(ForbiddenDepositRequestTransitionError);
            }
          }
        },
      ),
      FAST_CHECK_OPTIONS,
    );
  });
});
