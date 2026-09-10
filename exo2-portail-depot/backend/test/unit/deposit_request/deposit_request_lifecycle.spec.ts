import {
  DepositRequestLifecycleService,
  are_all_expected_documents_clean,
  type DepositRequestLifecycle,
} from '../../../src/deposit/deposit_request_lifecycle';
import type { DepositRequestStatus } from '../../../src/domain/deposit_request_status';
import { ForbiddenDepositRequestTransitionError } from '../../../src/domain/deposit_request_status';
import type { Clock } from '../../../src/shared/clock';
import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { FakeDepositRequestRepository } from '../../helpers/fake_deposit_request_repository';
import { REFERENCE_NOW } from '../../fixtures/domain_builders';

const DEPOSIT_REQUEST_ID = 'request-1';
const ACCESS_LINK_ID = 'link-1';

interface LifecycleHarness {
  activity_events: FakeActivityEventRepository;
  deposit_requests: FakeDepositRequestRepository;
  lifecycle: DepositRequestLifecycle;
  status_of: () => DepositRequestStatus | undefined;
}

function build_lifecycle_harness(initial_status: DepositRequestStatus): LifecycleHarness {
  const deposit_requests = new FakeDepositRequestRepository();
  const activity_events = new FakeActivityEventRepository();
  const clock: Clock = { now: (): Date => REFERENCE_NOW };

  deposit_requests.seed(DEPOSIT_REQUEST_ID, initial_status);

  return {
    activity_events,
    deposit_requests,
    lifecycle: new DepositRequestLifecycleService({ deposit_requests, activity_events, clock }),
    status_of: (): DepositRequestStatus | undefined =>
      deposit_requests.statuses.get(DEPOSIT_REQUEST_ID),
  };
}

describe('completude d une demande', () => {
  it('est atteinte quand chaque emplacement porte une piece saine', () => {
    expect(
      are_all_expected_documents_clean({
        expected_document_count: 3,
        clean_expected_document_count: 3,
      }),
    ).toBe(true);
  });

  it('n est pas atteinte tant qu un emplacement reste vide', () => {
    expect(
      are_all_expected_documents_clean({
        expected_document_count: 3,
        clean_expected_document_count: 2,
      }),
    ).toBe(false);
  });

  // Une coquille vide n'est pas un dossier abouti : la declarer complete ferait
  // valider une demande qui n'a jamais rien eu a recevoir.
  it('n est jamais atteinte par une demande sans aucun emplacement', () => {
    expect(
      are_all_expected_documents_clean({
        expected_document_count: 0,
        clean_expected_document_count: 0,
      }),
    ).toBe(false);
  });
});

describe('cycle de vie d une demande', () => {
  // LE point du design : le scan peut trouver toutes les pieces saines AVANT
  // que le client n'ait dit qu'il avait fini. Valider a sa place lui retirerait
  // le droit de remplacer encore une piece.
  it("ne valide pas une demande restee incomplete, meme si tout est sain", async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');

    await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'all_expected_documents_clean',
    });

    expect(harness.status_of()).toBe('incomplete');
    expect(harness.activity_events.recorded_types()).toEqual([]);
  });

  it('valide une demande que le client a terminee et dont tout est sain', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('processing');

    const status: DepositRequestStatus | null = await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'all_expected_documents_clean',
    });

    expect(status).toBe('validated');
    expect(harness.activity_events.recorded_types()).toEqual(['deposit_request_validated']);
  });

  it('rouvre une demande validee des qu une piece cesse d etre saine', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('validated');

    await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'expected_document_became_not_clean',
    });

    expect(harness.status_of()).toBe('incomplete');
    // La reouverture n'entre PAS au journal : le verdict ou le retrait qui l'a
    // causee y est deja, au meme instant.
    expect(harness.activity_events.recorded_types()).toEqual([]);
  });

  it('bloque une demande dont le lien vient d etre verrouille', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');

    await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'access_link_blocked',
    });

    expect(harness.status_of()).toBe('blocked');
    expect(harness.activity_events.recorded_types()).toEqual([]);
  });

  // Le lien n'est qu'un moyen d'acces : sa fin ne reprend pas un travail acheve.
  it('ne degrade pas une demande validee quand son lien se bloque ou expire', async () => {
    const on_block: LifecycleHarness = build_lifecycle_harness('validated');
    const on_expiry: LifecycleHarness = build_lifecycle_harness('validated');

    await on_block.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'access_link_blocked',
    });
    await on_expiry.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'access_link_expired',
    });

    expect(on_block.status_of()).toBe('validated');
    expect(on_expiry.status_of()).toBe('validated');
  });

  it('marque expiree une demande incomplete dont le lien a expire', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');

    await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'access_link_expired',
    });

    expect(harness.status_of()).toBe('expired_incomplete');
    expect(harness.activity_events.recorded_types()).toEqual(['deposit_request_expired']);
  });

  // La case que le code signalait lui-meme comme non fixee par un test : en
  // 'processing' tout est depose et le scan tourne, l'expiration du lien ne doit
  // pas interrompre un traitement qui va aboutir tout seul.
  it('laisse intacte une demande en traitement dont le lien a expire', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('processing');

    await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'access_link_expired',
    });

    expect(harness.status_of()).toBe('processing');
    expect(harness.activity_events.recorded_types()).toEqual([]);
  });

  // La reconciliation repasse sur les memes demandes toutes les quinze minutes :
  // une ligne par passe ferait du journal un compteur de balayages.
  it('ne journalise rien une seconde fois quand le statut ne bouge plus', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');

    await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'access_link_expired',
    });
    await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      event: 'access_link_expired',
    });

    expect(harness.activity_events.recorded_types()).toEqual(['deposit_request_expired']);
  });

  it('ne touche a rien sur une demande qui n existe plus', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');

    const status: DepositRequestStatus | null = await harness.lifecycle.apply_pipeline_event({
      deposit_request_id: 'demande-supprimee',
      event: 'all_expected_documents_clean',
    });

    expect(status).toBeNull();
    expect(harness.activity_events.recorded_types()).toEqual([]);
  });
});

describe('fin de depot annoncee par le client', () => {
  it('fait passer la demande en traitement et l inscrit au journal', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');

    const status: DepositRequestStatus | null = await harness.lifecycle.apply_client_action({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      access_link_id: ACCESS_LINK_ID,
      action: 'client_finished_deposit',
    });

    expect(status).toBe('processing');
    expect(harness.activity_events.recorded_events).toEqual([
      {
        deposit_request_id: DEPOSIT_REQUEST_ID,
        type: 'deposit_request_completed_by_client',
        actor: { kind: 'client' },
        access_link_id: ACCESS_LINK_ID,
        deposited_file_id: null,
        client_ip: null,
        occurred_at: REFERENCE_NOW,
      },
    ]);
  });

  // Contrairement au pipeline, il y a quelqu'un au bout du fil : terminer deux
  // fois est une interface qui a propose une action qu'elle n'aurait pas du
  // proposer, et le lui taire la laisserait dans l'erreur.
  it.each(['processing', 'validated', 'blocked', 'expired_incomplete'] as const)(
    "leve plutot que de laisser terminer un depot depuis '%s'",
    async (status) => {
      const harness: LifecycleHarness = build_lifecycle_harness(status);

      await expect(
        harness.lifecycle.apply_client_action({
          deposit_request_id: DEPOSIT_REQUEST_ID,
          access_link_id: ACCESS_LINK_ID,
          action: 'client_finished_deposit',
        }),
      ).rejects.toThrow(ForbiddenDepositRequestTransitionError);

      expect(harness.activity_events.recorded_types()).toEqual([]);
    },
  );

  // Le cas signale par l'evaluateur : le scan avait rendu son verdict AVANT que
  // le client ne clique sur « Terminer le depot ». A cet instant la demande
  // etait 'incomplete', et 'all_expected_documents_clean' n'y transite pas ;
  // plus rien ne revenait ensuite poser la question, et la demande restait « en
  // traitement » pour toujours alors que tout etait sain.
  it('valide immediatement une fin de depot dont toutes les pieces sont deja saines', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');
    harness.deposit_requests.seed_completion(DEPOSIT_REQUEST_ID, {
      expected_document_count: 1,
      clean_expected_document_count: 1,
    });

    const status: DepositRequestStatus | null = await harness.lifecycle.apply_client_action({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      access_link_id: ACCESS_LINK_ID,
      action: 'client_finished_deposit',
    });

    expect(status).toBe('validated');
    expect(harness.status_of()).toBe('validated');
    expect(harness.activity_events.recorded_types()).toEqual([
      'deposit_request_completed_by_client',
      'deposit_request_validated',
    ]);
  });

  // Le pendant du precedent : une piece encore en analyse doit laisser la
  // demande « en traitement ». Sans cette borne, la relecture de completude
  // validerait un dossier dont le verdict n'est pas tombe.
  it('laisse en traitement une fin de depot dont une piece attend encore son verdict', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('incomplete');
    harness.deposit_requests.seed_completion(DEPOSIT_REQUEST_ID, {
      expected_document_count: 2,
      clean_expected_document_count: 1,
    });

    const status: DepositRequestStatus | null = await harness.lifecycle.apply_client_action({
      deposit_request_id: DEPOSIT_REQUEST_ID,
      access_link_id: ACCESS_LINK_ID,
      action: 'client_finished_deposit',
    });

    expect(status).toBe('processing');
    expect(harness.activity_events.recorded_types()).toEqual([
      'deposit_request_completed_by_client',
    ]);
  });
});

describe('une piece devenue saine', () => {
  // La regle de completude vit dans le cycle de vie : le scan annonce un fait,
  // il ne decide pas de ce que « complet » veut dire.
  it('valide la demande terminee quand elle etait la derniere attendue', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('processing');
    harness.deposit_requests.seed_completion(DEPOSIT_REQUEST_ID, {
      expected_document_count: 2,
      clean_expected_document_count: 2,
    });

    await harness.lifecycle.notice_deposited_file_became_clean(DEPOSIT_REQUEST_ID);

    expect(harness.status_of()).toBe('validated');
  });

  it('ne consulte meme pas la machine tant qu un emplacement reste a pourvoir', async () => {
    const harness: LifecycleHarness = build_lifecycle_harness('processing');
    harness.deposit_requests.seed_completion(DEPOSIT_REQUEST_ID, {
      expected_document_count: 2,
      clean_expected_document_count: 1,
    });

    await harness.lifecycle.notice_deposited_file_became_clean(DEPOSIT_REQUEST_ID);

    expect(harness.status_of()).toBe('processing');
    expect(harness.deposit_requests.transition_attempt_count).toBe(0);
  });
});
