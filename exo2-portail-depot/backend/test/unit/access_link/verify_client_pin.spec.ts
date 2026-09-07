import {
  verify_client_pin,
  MAX_SUBMITTED_PIN_LENGTH,
  type PinHasher,
} from '../../../src/domain/verify_client_pin';
import {
  build_access_link,
  add_days,
  REFERENCE_NOW,
} from '../../../test/fixtures/domain_builders';

function build_pin_hasher(overrides: Partial<PinHasher> = {}): PinHasher {
  return {
    hash: jest.fn(),
    verify: jest.fn(),
    ...overrides,
  };
}

describe('verify_client_pin', () => {
  it('[1] accepte un PIN correct sur un lien actif et remet le compteur d échecs à zéro', async () => {
    const link = build_access_link({ failed_pin_attempts: 3 });
    const pin_hasher = build_pin_hasher({
      verify: jest.fn().mockResolvedValue(true),
    });
    const now = REFERENCE_NOW;

    const outcome = await verify_client_pin(link, '4821', now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(true);
    expect(outcome.rejection_reason).toBeNull();
    expect(outcome.link_after_attempt.failed_pin_attempts).toBe(0);
    expect(outcome.link_just_became_blocked).toBe(false);
  });

  it('[2] refuse un PIN incorrect et incrémente le compteur d échecs', async () => {
    const link = build_access_link({ failed_pin_attempts: 1 });
    const pin_hasher = build_pin_hasher({
      verify: jest.fn().mockResolvedValue(false),
    });
    const now = REFERENCE_NOW;

    const outcome = await verify_client_pin(link, '0000', now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(false);
    expect(outcome.rejection_reason).toBe('pin_incorrect');
    expect(outcome.link_after_attempt.failed_pin_attempts).toBe(2);
    expect(outcome.link_just_became_blocked).toBe(false);
  });

  it('[3] bloque le lien au N-ième échec (status blocked, link_just_became_blocked à true)', async () => {
    const link = build_access_link({
      max_pin_attempts: 5,
      failed_pin_attempts: 4,
    });
    const pin_hasher = build_pin_hasher({
      verify: jest.fn().mockResolvedValue(false),
    });
    const now = REFERENCE_NOW;

    const outcome = await verify_client_pin(link, '0000', now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(false);
    expect(outcome.link_after_attempt.status).toBe('blocked');
    expect(outcome.link_after_attempt.failed_pin_attempts).toBe(5);
    expect(outcome.link_just_became_blocked).toBe(true);
  });

  it('[4] refuse un PIN correct sur un lien bloqué avec rejection_reason link_blocked (le blocage prime sur la validité du code)', async () => {
    const link = build_access_link({ status: 'blocked', blocked_at: REFERENCE_NOW });
    const pin_hasher = build_pin_hasher({
      verify: jest.fn().mockResolvedValue(true),
    });
    const now = REFERENCE_NOW;

    const outcome = await verify_client_pin(link, '4821', now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(false);
    expect(outcome.rejection_reason).toBe('link_blocked');
  });

  it('[5] refuse un PIN correct sur un lien expiré avec rejection_reason link_invalid', async () => {
    const link = build_access_link({
      expires_at: add_days(REFERENCE_NOW, -1),
    });
    const pin_hasher = build_pin_hasher({
      verify: jest.fn().mockResolvedValue(true),
    });
    const now = REFERENCE_NOW;

    const outcome = await verify_client_pin(link, '4821', now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(false);
    expect(outcome.rejection_reason).toBe('link_invalid');
  });

  it('[6] refuse un PIN correct sur un lien révoqué', async () => {
    const link = build_access_link({
      status: 'revoked',
      revoked_at: REFERENCE_NOW,
    });
    const pin_hasher = build_pin_hasher({
      verify: jest.fn().mockResolvedValue(true),
    });
    const now = REFERENCE_NOW;

    const outcome = await verify_client_pin(link, '4821', now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(false);
  });

  it('[7] refuse avec pin_length_mismatch un PIN dont la longueur ne correspond pas à link.pin_length ET consomme quand même un essai', async () => {
    const link = build_access_link({ pin_length: 4, failed_pin_attempts: 0 });
    const pin_hasher = build_pin_hasher();
    const now = REFERENCE_NOW;

    const outcome = await verify_client_pin(link, '12345', now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(false);
    expect(outcome.rejection_reason).toBe('pin_length_mismatch');
    expect(outcome.link_after_attempt.failed_pin_attempts).toBe(1);
  });

  it('[8] appelle toujours le hasher sur un lien utilisable, quel que soit le PIN soumis (absence de fuite temporelle)', async () => {
    const link = build_access_link();
    const verify = jest.fn().mockResolvedValue(false);
    const pin_hasher = build_pin_hasher({ verify });
    const now = REFERENCE_NOW;

    await verify_client_pin(link, '9999', now, { pin_hasher });

    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('[9] ne fait jamais apparaître le PIN soumis ni le pin_hash dans l objet retourné', async () => {
    const link = build_access_link();
    const pin_hasher = build_pin_hasher({
      verify: jest.fn().mockResolvedValue(true),
    });
    const now = REFERENCE_NOW;
    const submitted_pin = '4821';

    const outcome = await verify_client_pin(link, submitted_pin, now, {
      pin_hasher,
    });

    // On ne verifie que l'absence du PIN soumis : `link_after_attempt` porte
    // legitimement `pin_hash`, puisque l'appelant doit persister le lien. Empecher
    // le hash de sortir est un probleme de couche transport, pas de domaine.
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(submitted_pin);
  });

  it('[74] rejette avec submitted_pin_too_long une chaîne dépassant MAX_SUBMITTED_PIN_LENGTH avant tout hachage, sans jamais appeler pin_hasher.verify', async () => {
    const link = build_access_link();
    const verify = jest.fn().mockResolvedValue(true);
    const pin_hasher = build_pin_hasher({ verify });
    const now = REFERENCE_NOW;
    const oversized_pin = '1'.repeat(MAX_SUBMITTED_PIN_LENGTH + 1);

    const outcome = await verify_client_pin(link, oversized_pin, now, {
      pin_hasher,
    });

    expect(outcome.granted).toBe(false);
    expect(outcome.rejection_reason).toBe('submitted_pin_too_long');
    expect(verify).not.toHaveBeenCalled();
  });
});
