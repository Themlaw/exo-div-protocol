import {
  ACTIVITY_EVENT_TYPES,
  CLIENT_IP_RETENTION_DAYS,
  build_activity_event,
  does_activity_event_type_carry_client_ip,
  has_activity_event_client_ip_expired,
  redact_activity_event,
  summarize_deposit_request_activity,
  type ActivityEvent,
  type ActivityEventType,
  type DepositRequestActivitySummary,
  type NewActivityEvent,
} from '../../../src/domain/activity_event';
import {
  REFERENCE_NOW,
  add_days,
  build_recorded_activity_event,
} from '../../fixtures/domain_builders';

const CLIENT_IP = '203.0.113.42';

// Les trois seuls types dont l'adresse sert reellement a quelque chose : ils
// decrivent tous une tentative d'entree.
const IP_BEARING_TYPES: readonly ActivityEventType[] = [
  'client_pin_rejected',
  'access_link_blocked',
  'unusable_access_link_attempted',
  'deposit_session_opened',
];

const TYPES_WITHOUT_IP: readonly ActivityEventType[] = ACTIVITY_EVENT_TYPES.filter(
  (type: ActivityEventType): boolean => !IP_BEARING_TYPES.includes(type),
);

describe('does_activity_event_type_carry_client_ip', () => {
  it.each(IP_BEARING_TYPES)("un evenement '%s' peut porter l'adresse du client", (type) => {
    expect(does_activity_event_type_carry_client_ip(type)).toBe(true);
  });

  // Le depot d'une piece, son verdict ou son telechargement n'apprennent rien
  // qu'une adresse rendrait plus clair : la conserver serait une donnee
  // personnelle gardee sans usage.
  it.each(TYPES_WITHOUT_IP)("un evenement '%s' n'en porte jamais", (type) => {
    expect(does_activity_event_type_carry_client_ip(type)).toBe(false);
  });
});

describe('build_activity_event', () => {
  // LE point du bloc : le constructeur ECARTE l'adresse au lieu de faire
  // confiance a l'appelant. Une consigne se contourne par distraction, une
  // fonction non.
  it("laisse tomber l'adresse sur un type qui n'a pas a la porter", () => {
    const event: NewActivityEvent = build_activity_event({
      deposit_request_id: 'request-1',
      type: 'deposited_file_received',
      actor: { kind: 'client' },
      deposited_file_id: 'file-1',
      client_ip: CLIENT_IP,
      occurred_at: REFERENCE_NOW,
    });

    expect(event.client_ip).toBeNull();
  });

  it("conserve l'adresse sur un PIN refuse, ou elle est le seul indice exploitable", () => {
    const event: NewActivityEvent = build_activity_event({
      deposit_request_id: 'request-1',
      type: 'client_pin_rejected',
      actor: { kind: 'client' },
      access_link_id: 'link-1',
      client_ip: CLIENT_IP,
      occurred_at: REFERENCE_NOW,
    });

    expect(event.client_ip).toBe(CLIENT_IP);
  });

  it('rend null sur les sujets non fournis plutot que de les omettre', () => {
    const event: NewActivityEvent = build_activity_event({
      deposit_request_id: 'request-1',
      type: 'access_link_issued',
      actor: { kind: 'lawyer', user_id: 'user-1' },
      access_link_id: 'link-1',
      occurred_at: REFERENCE_NOW,
    });

    expect(event.deposited_file_id).toBeNull();
    expect(event.client_ip).toBeNull();
  });
});

describe("l'acteur d'un evenement", () => {
  it("distingue l'avocat, le client anonyme et le systeme", () => {
    const by_lawyer: NewActivityEvent = build_activity_event({
      deposit_request_id: 'request-1',
      type: 'deposited_file_downloaded',
      actor: { kind: 'lawyer', user_id: 'user-1' },
      deposited_file_id: 'file-1',
      occurred_at: REFERENCE_NOW,
    });
    const by_client: NewActivityEvent = build_activity_event({
      deposit_request_id: 'request-1',
      type: 'deposited_file_received',
      actor: { kind: 'client' },
      deposited_file_id: 'file-1',
      occurred_at: REFERENCE_NOW,
    });
    const by_system: NewActivityEvent = build_activity_event({
      deposit_request_id: 'request-1',
      type: 'deposited_file_scanned_clean',
      actor: { kind: 'system' },
      deposited_file_id: 'file-1',
      occurred_at: REFERENCE_NOW,
    });

    expect(by_lawyer.actor).toEqual({ kind: 'lawyer', user_id: 'user-1' });
    // Un client n'a pas d'identifiant, et ce n'est pas pour autant le systeme :
    // confondre les deux ferait passer un depot pour une action du serveur.
    expect(by_client.actor).toEqual({ kind: 'client' });
    expect(by_system.actor).toEqual({ kind: 'system' });
  });
});

describe('redact_activity_event', () => {
  it("efface l'adresse et ne touche a rien d'autre", () => {
    const recorded: ActivityEvent = build_recorded_activity_event({
      type: 'client_pin_rejected',
      client_ip: CLIENT_IP,
    });

    const redacted: ActivityEvent = redact_activity_event(recorded);

    expect(redacted).toEqual({ ...recorded, client_ip: null });
  });

  // Le balayage repasse sur les memes lignes : sans idempotence il reecrirait
  // sans fin des evenements deja expurges.
  it('expurger deux fois ne change rien', () => {
    const recorded: ActivityEvent = build_recorded_activity_event({
      type: 'client_pin_rejected',
      client_ip: CLIENT_IP,
    });

    expect(redact_activity_event(redact_activity_event(recorded))).toEqual(
      redact_activity_event(recorded),
    );
  });
});

describe('has_activity_event_client_ip_expired', () => {
  it("est vrai une fois le delai de conservation depasse", () => {
    const recorded: ActivityEvent = build_recorded_activity_event({
      type: 'client_pin_rejected',
      client_ip: CLIENT_IP,
      occurred_at: add_days(REFERENCE_NOW, -(CLIENT_IP_RETENTION_DAYS + 1)),
    });

    expect(
      has_activity_event_client_ip_expired(recorded, CLIENT_IP_RETENTION_DAYS, REFERENCE_NOW),
    ).toBe(true);
  });

  it('est faux tant que le delai court encore', () => {
    const recorded: ActivityEvent = build_recorded_activity_event({
      type: 'client_pin_rejected',
      client_ip: CLIENT_IP,
      occurred_at: add_days(REFERENCE_NOW, -(CLIENT_IP_RETENTION_DAYS - 1)),
    });

    expect(
      has_activity_event_client_ip_expired(recorded, CLIENT_IP_RETENTION_DAYS, REFERENCE_NOW),
    ).toBe(false);
  });

  // Sans cette reponse, la purge selectionnerait indefiniment des lignes qui
  // n'ont plus rien a effacer.
  it("est faux sur un evenement qui ne porte deja plus d'adresse", () => {
    const recorded: ActivityEvent = build_recorded_activity_event({
      type: 'deposited_file_received',
      client_ip: null,
      occurred_at: add_days(REFERENCE_NOW, -3650),
    });

    expect(
      has_activity_event_client_ip_expired(recorded, CLIENT_IP_RETENTION_DAYS, REFERENCE_NOW),
    ).toBe(false);
  });
});

describe('summarize_deposit_request_activity', () => {
  it('ne signale aucun probleme sur une demande qui ne s est jamais mal passee', () => {
    const summary: DepositRequestActivitySummary = summarize_deposit_request_activity([
      build_recorded_activity_event({ type: 'access_link_issued' }),
      build_recorded_activity_event({ type: 'deposit_session_opened' }),
      build_recorded_activity_event({ type: 'deposited_file_received' }),
      build_recorded_activity_event({ type: 'deposited_file_scanned_clean' }),
      build_recorded_activity_event({ type: 'deposited_file_downloaded' }),
    ]);

    expect(summary).toEqual({
      has_problem: false,
      infected_count: 0,
      rejected_count: 0,
      rejected_pin_attempt_count: 0,
      unusable_link_attempt_count: 0,
      was_link_blocked: false,
    });
  });

  it('signale une piece infectee', () => {
    const summary: DepositRequestActivitySummary = summarize_deposit_request_activity([
      build_recorded_activity_event({ type: 'deposited_file_scanned_infected' }),
    ]);

    expect(summary).toMatchObject({ has_problem: true, infected_count: 1, rejected_count: 0 });
  });

  // L'avocat doit pouvoir distinguer « votre client a envoye un virus » de
  // « votre client s'est trompe de fichier » : ce ne sont pas les memes suites.
  it('compte separement une piece refusee et une piece infectee', () => {
    const summary: DepositRequestActivitySummary = summarize_deposit_request_activity([
      build_recorded_activity_event({ type: 'deposited_file_rejected' }),
      build_recorded_activity_event({ type: 'deposited_file_scanned_infected' }),
      build_recorded_activity_event({ type: 'deposited_file_rejected' }),
    ]);

    expect(summary).toMatchObject({ has_problem: true, rejected_count: 2, infected_count: 1 });
  });

  // Le resume raconte ce qui S'EST PASSE, pas l'etat courant : un lien reemis
  // depuis n'efface pas le fait que le precedent a ete bloque.
  it('retient les PIN refuses et le blocage, meme si un lien a ete reemis depuis', () => {
    const summary: DepositRequestActivitySummary = summarize_deposit_request_activity([
      build_recorded_activity_event({ type: 'client_pin_rejected' }),
      build_recorded_activity_event({ type: 'client_pin_rejected' }),
      build_recorded_activity_event({ type: 'client_pin_rejected' }),
      build_recorded_activity_event({ type: 'access_link_blocked' }),
      build_recorded_activity_event({ type: 'access_link_issued' }),
    ]);

    expect(summary).toMatchObject({
      has_problem: true,
      rejected_pin_attempt_count: 3,
      was_link_blocked: true,
    });
  });

  it('ne compte ni un depot reussi ni un telechargement comme un probleme', () => {
    const summary: DepositRequestActivitySummary = summarize_deposit_request_activity([
      build_recorded_activity_event({ type: 'deposited_file_received' }),
      build_recorded_activity_event({ type: 'deposited_file_removed' }),
      build_recorded_activity_event({ type: 'deposited_file_downloaded' }),
      build_recorded_activity_event({ type: 'access_link_revoked' }),
    ]);

    expect(summary.has_problem).toBe(false);
  });

  it('rend un resume vide sur une demande sans aucun evenement', () => {
    expect(summarize_deposit_request_activity([])).toEqual({
      has_problem: false,
      infected_count: 0,
      rejected_count: 0,
      rejected_pin_attempt_count: 0,
      unusable_link_attempt_count: 0,
      was_link_blocked: false,
    });
  });
});

describe('tentatives sur un lien qui n ouvre plus', () => {
  // Elles n'ont refuse aucun PIN et pourtant elles expliquent, mieux que tout
  // le reste, pourquoi une demande est restee vide.
  it('sont comptees a part et font un probleme', () => {
    const summary: DepositRequestActivitySummary = summarize_deposit_request_activity([
      build_recorded_activity_event({ type: 'unusable_access_link_attempted' }),
      build_recorded_activity_event({ type: 'unusable_access_link_attempted' }),
    ]);

    expect(summary).toMatchObject({
      has_problem: true,
      unusable_link_attempt_count: 2,
      rejected_pin_attempt_count: 0,
    });
  });

  it("gardent l'adresse du client, comme toute tentative d'entree", () => {
    const event: NewActivityEvent = build_activity_event({
      deposit_request_id: 'request-1',
      type: 'unusable_access_link_attempted',
      actor: { kind: 'client' },
      access_link_id: 'link-1',
      client_ip: CLIENT_IP,
      occurred_at: REFERENCE_NOW,
    });

    expect(event.client_ip).toBe(CLIENT_IP);
  });
});
