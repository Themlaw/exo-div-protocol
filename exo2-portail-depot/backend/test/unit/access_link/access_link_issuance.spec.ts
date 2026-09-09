import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import {
  AccessLinkIssuanceService,
  CLIENT_DEPOSIT_PATH,
  type AccessLinkDelivery,
} from '../../../src/access_link/access_link_issuer';
import type {
  AccessLinkIssuance,
  AccessLinkRepository,
} from '../../../src/access_link/access_link_repository';
import type { AccessLink } from '../../../src/domain/access_link';
import type { PinHasher } from '../../../src/domain/verify_client_pin';
import type { RandomSource } from '../../../src/domain/presigned_upload';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import type { NewActivityEvent } from '../../../src/domain/activity_event';

const ISSUANCE_INPUT = {
  deposit_request_id: '11111111-2222-3333-4444-555555555555',
  owner_user_id: 'avocat-1',
  deposit_request_title: 'Dossier de succession',
  security_policy: DEFAULT_SECURITY_POLICY,
} as const;

function build_access_link_from_issuance(issuance: AccessLinkIssuance): AccessLink {
  return {
    id: 'link-1',
    deposit_request_id: ISSUANCE_INPUT.deposit_request_id,
    token_hmac: issuance.token_hmac,
    token_pepper_version: issuance.token_pepper_version,
    pin_hash: issuance.pin_hash,
    pin_length: issuance.security_policy.pin_length,
    max_pin_attempts: issuance.security_policy.max_pin_attempts,
    failed_pin_attempts: 0,
    status: 'active',
    expires_at: issuance.expires_at,
    created_at: new Date('2026-03-12T10:00:00.000Z'),
    blocked_at: null,
    revoked_at: null,
  };
}

function build_issuance_service(options: { ownership_confirmed: boolean }): {
  service: AccessLinkIssuanceService;
  hashing_call_count: () => number;
  random_draw_count: () => number;
  activity_events: FakeActivityEventRepository;
} {
  let hashing_call_count = 0;
  let random_draw_count = 0;

  const random_source: RandomSource = {
    bytes: (length: number): Buffer => {
      random_draw_count += 1;
      return Buffer.alloc(length, 7);
    },
  };

  const pin_hasher: PinHasher = {
    hash: async (): Promise<string> => {
      hashing_call_count += 1;
      return 'hachage-du-pin';
    },
    verify: async (): Promise<boolean> => false,
  };

  const access_links: AccessLinkRepository = {
    confirms_deposit_request_ownership: async (): Promise<boolean> => options.ownership_confirmed,
    issue_link_replacing_current: async (input): Promise<AccessLink | null> =>
      build_access_link_from_issuance(input.issuance),
    find_by_token_hmac: async (): Promise<AccessLink | null> => null,
    save_attempt_outcome: async (): Promise<boolean> => true,
    revoke_current_link: async (): Promise<string | null> => 'link-revoque',
  };

  const activity_events = new FakeActivityEventRepository();

  return {
    service: new AccessLinkIssuanceService({
      access_links,
      activity_events,
      token_hasher: {
        fingerprint_token: (token: string) => ({
          token_hmac: `hmac-de-${token}`,
          token_pepper_version: 1,
        }),
      },
      pin_hasher,
      clock: { now: (): Date => new Date('2026-03-12T10:00:00.000Z') },
      random_source,
      public_base_url: 'https://portail.fr/',
    }),
    hashing_call_count: (): number => hashing_call_count,
    random_draw_count: (): number => random_draw_count,
    activity_events,
  };
}

describe("AccessLinkIssuanceService", () => {
  // Une session avocat valide ne dit rien de la demande visee : etre
  // authentifie n'est pas etre proprietaire. Emettre coute un hachage argon2 de
  // ~130 ms, et le payer avant de le savoir offrirait ce travail a un compte
  // authentifie qui enverrait des identifiants au hasard, au nom de n'importe
  // quel confrere.
  it("ne tire ni token ni PIN, et ne hache rien, quand la demande n'appartient pas au demandeur", async () => {
    const { service, hashing_call_count, random_draw_count } = build_issuance_service({
      ownership_confirmed: false,
    });

    await expect(service.issue_for_deposit_request(ISSUANCE_INPUT)).resolves.toBeNull();

    expect(hashing_call_count()).toBe(0);
    expect(random_draw_count()).toBe(0);
  });

  it("emet le couple et compose le message quand la demande est bien celle de l'avocat", async () => {
    const { service, hashing_call_count } = build_issuance_service({
      ownership_confirmed: true,
    });

    const delivery = (await service.issue_for_deposit_request(
      ISSUANCE_INPUT,
    )) as AccessLinkDelivery;

    expect(delivery.url).toContain(`${CLIENT_DEPOSIT_PATH}/`);
    // La base d'URL porte une barre finale : la dupliquer donnerait une adresse
    // qui ne resout pas la meme route selon le serveur qui la sert.
    expect(delivery.url).not.toContain('//deposit');
    expect(delivery.pin).toHaveLength(DEFAULT_SECURITY_POLICY.pin_length);
    expect(delivery.message).toContain(delivery.pin);
    expect(hashing_call_count()).toBe(1);
  });

  it("journalise l emission au nom de l avocat, en portant l identifiant du lien emis", async () => {
    const { service, activity_events } = build_issuance_service({ ownership_confirmed: true });

    await service.issue_for_deposit_request(ISSUANCE_INPUT);

    expect(activity_events.recorded_events).toEqual<NewActivityEvent[]>([
      {
        deposit_request_id: ISSUANCE_INPUT.deposit_request_id,
        type: 'access_link_issued',
        actor: { kind: 'lawyer', user_id: ISSUANCE_INPUT.owner_user_id },
        access_link_id: 'link-1',
        deposited_file_id: null,
        client_ip: null,
        occurred_at: new Date('2026-03-12T10:00:00.000Z'),
      },
    ]);
  });

  it("ne journalise rien quand la demande n'appartient pas au demandeur", async () => {
    const { service, activity_events } = build_issuance_service({ ownership_confirmed: false });

    await service.issue_for_deposit_request(ISSUANCE_INPUT);

    expect(activity_events.recorded_types()).toEqual([]);
  });
});
