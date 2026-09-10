import type {
  DepositRequestPipelineEvent,
  DepositRequestStatus,
  DepositRequestUserAction,
} from '../domain/deposit_request_status';
import {
  apply_deposit_request_pipeline_event,
  apply_deposit_request_user_action,
} from '../domain/deposit_request_status';
import type { ActivityEventType } from '../domain/activity_event';
import { build_activity_event } from '../domain/activity_event';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import type { Clock } from '../shared/clock';
import type {
  DepositRequestCompletion,
  DepositRequestRepository,
  DepositRequestStatusTransition,
} from './deposit_request_repository';

export const DEPOSIT_REQUEST_LIFECYCLE: unique symbol = Symbol('DEPOSIT_REQUEST_LIFECYCLE');

// Les seuls changements d'etat qui entrent au journal. Une transition absente de
// cette table se produit quand meme — elle n'est simplement pas racontee, parce
// que la ligne qui la CAUSE est deja au journal, au meme instant : un blocage
// est dit par `access_link_blocked`, une reouverture par le verdict ou le
// retrait qui l'a provoquee. Les redire une ligne plus bas rendrait l'histoire
// moins lisible, pas plus.
const JOURNALIZED_STATUS_ARRIVALS: Partial<Record<DepositRequestStatus, ActivityEventType>> = {
  validated: 'deposit_request_validated',
  expired_incomplete: 'deposit_request_expired',
};

export interface DepositRequestLifecycle {
  // Total : ne leve jamais, et rend le statut apres coup. Un evenement de
  // pipeline n'a personne au bout du fil, et arrive dans un ordre qu'on ne
  // maitrise pas — un verdict de scan peut tomber trois secondes apres le
  // blocage du lien.
  apply_pipeline_event(input: {
    deposit_request_id: string;
    event: DepositRequestPipelineEvent;
  }): Promise<DepositRequestStatus | null>;

  // La regle de completude vit ICI, et non chez l'appelant : le scan sait
  // qu'une piece est devenue saine, il n'a pas a savoir ce que « le dossier est
  // complet » veut dire. La lui faire porter aurait mis cette regle a deux
  // endroits le jour ou un second chemin rendrait une piece saine.
  notice_deposited_file_became_clean(deposit_request_id: string): Promise<DepositRequestStatus | null>;

  // Leve sur une transition interdite, contrairement au pipeline : il y a
  // quelqu'un au bout du fil, et terminer deux fois un depot est une interface
  // qui a propose une action qu'elle n'aurait pas du proposer.
  apply_client_action(input: {
    deposit_request_id: string;
    access_link_id: string;
    action: DepositRequestUserAction;
  }): Promise<DepositRequestStatus | null>;
}

export interface DepositRequestLifecycleDependencies {
  deposit_requests: DepositRequestRepository;
  activity_events: ActivityEventRepository;
  clock: Clock;
}

// Le SEUL endroit ou le statut d'une demande change. Cinq chemins l'appellent —
// un verdict de scan, un retrait, un blocage, une expiration, un client qui a
// fini — et aucun d'eux ne connait la table des transitions : la faire lire par
// cinq appelants aurait garanti que l'un d'eux finisse par diverger.
export class DepositRequestLifecycleService implements DepositRequestLifecycle {
  constructor(private readonly dependencies: DepositRequestLifecycleDependencies) {}

  async apply_pipeline_event(input: {
    deposit_request_id: string;
    event: DepositRequestPipelineEvent;
  }): Promise<DepositRequestStatus | null> {
    const transition: DepositRequestStatusTransition | null =
      await this.dependencies.deposit_requests.apply_status_transition(
        input.deposit_request_id,
        (current: DepositRequestStatus): DepositRequestStatus =>
          apply_deposit_request_pipeline_event(current, input.event),
      );

    if (transition === null) {
      return null;
    }

    await this.journalize_arrival(input.deposit_request_id, transition, { kind: 'system' });
    return transition.status_after;
  }

  async notice_deposited_file_became_clean(
    deposit_request_id: string,
  ): Promise<DepositRequestStatus | null> {
    return this.validate_when_every_expected_document_is_clean(deposit_request_id);
  }

  async apply_client_action(input: {
    deposit_request_id: string;
    access_link_id: string;
    action: DepositRequestUserAction;
  }): Promise<DepositRequestStatus | null> {
    const transition: DepositRequestStatusTransition | null =
      await this.dependencies.deposit_requests.apply_status_transition(
        input.deposit_request_id,
        (current: DepositRequestStatus): DepositRequestStatus =>
          apply_deposit_request_user_action(current, input.action),
      );

    if (transition === null) {
      return null;
    }

    await this.dependencies.activity_events.record(
      build_activity_event({
        deposit_request_id: input.deposit_request_id,
        type: 'deposit_request_completed_by_client',
        actor: { kind: 'client' },
        access_link_id: input.access_link_id,
        occurred_at: this.dependencies.clock.now(),
      }),
    );

    // La completude est REPOSEE ici, et pas seulement a la chute d'un verdict :
    // le scan est plus rapide que le client, et un dossier dont toutes les
    // pieces etaient deja saines restait « en traitement » pour toujours. La
    // transition 'all_expected_documents_clean' ne part que de 'processing', et
    // au moment du verdict la demande etait encore 'incomplete' — personne ne
    // revenait poser la question apres le clic de fin de depot.
    const status_after_completeness: DepositRequestStatus | null =
      await this.validate_when_every_expected_document_is_clean(input.deposit_request_id);

    return status_after_completeness ?? transition.status_after;
  }

  // Le seul endroit qui traduit « toutes les pieces sont saines » en transition.
  // Les deux chemins qui peuvent rendre une demande complete — le verdict de
  // scan et le clic de fin de depot — passent par lui, sinon l'un des deux
  // finirait par oublier la moitie de la regle.
  private async validate_when_every_expected_document_is_clean(
    deposit_request_id: string,
  ): Promise<DepositRequestStatus | null> {
    const completion: DepositRequestCompletion =
      await this.dependencies.deposit_requests.read_completion(deposit_request_id);

    if (!are_all_expected_documents_clean(completion)) {
      return null;
    }

    return this.apply_pipeline_event({
      deposit_request_id,
      event: 'all_expected_documents_clean',
    });
  }

  // Journalise APRES l'ecriture du statut, et seulement si le statut a REELLEMENT
  // change : la reconciliation repasse sur les memes demandes, et une ligne par
  // passe ferait du journal un compteur de balayages.
  private async journalize_arrival(
    deposit_request_id: string,
    transition: DepositRequestStatusTransition,
    actor: { kind: 'system' },
  ): Promise<void> {
    if (transition.status_after === transition.status_before) {
      return;
    }

    const type: ActivityEventType | undefined =
      JOURNALIZED_STATUS_ARRIVALS[transition.status_after];
    if (type === undefined) {
      return;
    }

    await this.dependencies.activity_events.record(
      build_activity_event({
        deposit_request_id,
        type,
        actor,
        occurred_at: this.dependencies.clock.now(),
      }),
    );
  }
}

// La completude est un fait VERIFIE, jamais espere : seule une piece dont le
// verdict est tombe compte. Une piece en attente de scan laisse la demande
// incomplete, sinon un dossier serait declare bon avant d'avoir ete examine.
export function are_all_expected_documents_clean(completion: DepositRequestCompletion): boolean {
  // Une demande sans aucun emplacement n'est pas « complete » : elle n'a rien a
  // recevoir, et la declarer validee ferait passer une coquille vide pour un
  // dossier abouti.
  return completion.expected_document_count > 0 &&
    completion.clean_expected_document_count === completion.expected_document_count;
}
