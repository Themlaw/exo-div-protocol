import {
  ForbiddenDepositRequestTransitionError,
  apply_deposit_request_user_action,
  apply_deposit_request_pipeline_event,
  type DepositRequestUserAction,
  type DepositRequestPipelineEvent,
  type DepositRequestStatus,
} from '../../../src/domain/deposit_request_status';

const ALL_STATUSES: DepositRequestStatus[] = [
  'incomplete',
  'processing',
  'validated',
  'blocked',
  'expired_incomplete',
];

const ALL_USER_ACTIONS: DepositRequestUserAction[] = ['client_finished_deposit'];

const ALL_PIPELINE_EVENTS: DepositRequestPipelineEvent[] = [
  'all_expected_documents_clean',
  'expected_document_became_not_clean',
  'access_link_blocked',
  'access_link_expired',
];

describe('apply_deposit_request_user_action', () => {
  it("[18] 'incomplete' + 'client_finished_deposit' -> 'processing' au clic de fin de depot", () => {
    expect(apply_deposit_request_user_action('incomplete', 'client_finished_deposit')).toBe(
      'processing',
    );
  });

  const forbidden_cases: [DepositRequestStatus, DepositRequestUserAction][] = [
    ['validated', 'client_finished_deposit'],
    ['processing', 'client_finished_deposit'],
    ['blocked', 'client_finished_deposit'],
    ['expired_incomplete', 'client_finished_deposit'],
  ];

  it.each(forbidden_cases)(
    "[24] la transition '%s' + '%s' est interdite et leve ForbiddenDepositRequestTransitionError",
    (status, action) => {
      expect(() => apply_deposit_request_user_action(status, action)).toThrow(
        ForbiddenDepositRequestTransitionError,
      );
    },
  );

  const all_combinations: [DepositRequestStatus, DepositRequestUserAction][] = ALL_STATUSES.flatMap(
    (status) =>
      ALL_USER_ACTIONS.map((action): [DepositRequestStatus, DepositRequestUserAction] => [
        status,
        action,
      ]),
  );

  it.each(all_combinations)(
    "le couple ('%s', '%s') renvoie toujours un statut valide ou leve ForbiddenDepositRequestTransitionError, jamais autre chose",
    (status, action) => {
      let result: DepositRequestStatus | undefined;

      try {
        result = apply_deposit_request_user_action(status, action);
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenDepositRequestTransitionError);
        return;
      }

      expect(ALL_STATUSES).toContain(result);
    },
  );
});

describe('apply_deposit_request_pipeline_event', () => {
  it("[19] 'processing' + 'all_expected_documents_clean' -> 'validated'", () => {
    expect(
      apply_deposit_request_pipeline_event('processing', 'all_expected_documents_clean'),
    ).toBe('validated');
  });

  it("[20] 'processing' + 'expected_document_became_not_clean' -> 'incomplete' : la completude est revocable", () => {
    expect(
      apply_deposit_request_pipeline_event('processing', 'expected_document_became_not_clean'),
    ).toBe('incomplete');
  });

  it("[20 bis] 'validated' + 'expected_document_became_not_clean' -> 'incomplete'", () => {
    expect(
      apply_deposit_request_pipeline_event('validated', 'expected_document_became_not_clean'),
    ).toBe('incomplete');
  });

  it("[21] 'access_link_blocked' depuis 'incomplete' -> 'blocked'", () => {
    expect(apply_deposit_request_pipeline_event('incomplete', 'access_link_blocked')).toBe(
      'blocked',
    );
  });

  it("[21] 'access_link_blocked' depuis 'processing' -> 'blocked'", () => {
    expect(apply_deposit_request_pipeline_event('processing', 'access_link_blocked')).toBe(
      'blocked',
    );
  });

  it("[22] 'access_link_expired' depuis 'incomplete' -> 'expired_incomplete'", () => {
    expect(apply_deposit_request_pipeline_event('incomplete', 'access_link_expired')).toBe(
      'expired_incomplete',
    );
  });

  it("[23] 'access_link_expired' depuis 'validated' -> reste 'validated' : une demande deja validee ne se degrade pas", () => {
    expect(apply_deposit_request_pipeline_event('validated', 'access_link_expired')).toBe(
      'validated',
    );
  });

  it("[17] 'incomplete' + 'all_expected_documents_clean' -> reste 'incomplete' : le scan peut voir toutes les pieces saines avant le clic client sur 'Terminer le depot', et seule cette action explicite bascule en 'processing'", () => {
    expect(apply_deposit_request_pipeline_event('incomplete', 'all_expected_documents_clean')).toBe(
      'incomplete',
    );
  });

  const irrelevant_cases: [DepositRequestStatus, DepositRequestPipelineEvent][] = [
    ['blocked', 'expected_document_became_not_clean'],
    ['expired_incomplete', 'all_expected_documents_clean'],
    ['blocked', 'access_link_expired'],
    ['expired_incomplete', 'access_link_blocked'],
    ['blocked', 'access_link_blocked'],
    ['expired_incomplete', 'access_link_expired'],
    ['incomplete', 'expected_document_became_not_clean'],
    ['validated', 'all_expected_documents_clean'],
  ];

  it.each(irrelevant_cases)(
    "le couple ('%s', '%s') laisse le statut inchange et ne leve aucune exception : un evenement de pipeline qui arrive hors ordre (ex. un verdict de scan apres le blocage du lien) est une course normale, pas une erreur",
    (status, event) => {
      expect(() => apply_deposit_request_pipeline_event(status, event)).not.toThrow();
      expect(apply_deposit_request_pipeline_event(status, event)).toBe(status);
    },
  );

  const all_combinations: [DepositRequestStatus, DepositRequestPipelineEvent][] = ALL_STATUSES.flatMap(
    (status) =>
      ALL_PIPELINE_EVENTS.map((event): [DepositRequestStatus, DepositRequestPipelineEvent] => [
        status,
        event,
      ]),
  );

  it.each(all_combinations)(
    "le couple ('%s', '%s') ne leve jamais et renvoie toujours un statut valide : la fonction est totale, indispensable pour le worker de scan qui recoit les evenements dans un ordre non maitrise",
    (status, event) => {
      expect(() => apply_deposit_request_pipeline_event(status, event)).not.toThrow();
      expect(ALL_STATUSES).toContain(apply_deposit_request_pipeline_event(status, event));
    },
  );
});
