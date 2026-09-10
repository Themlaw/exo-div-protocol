import type { AccessLink } from '../domain/access_link';
import type { DepositedFile } from '../domain/deposited_file';
import { plan_deposited_file_removal, type DepositedFileRemovalPlan } from '../domain/deposited_file';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
} from '../object_storage/object_storage';
import type {
  ClientDepositRequestView,
  DepositRequestRepository,
} from '../deposit/deposit_request_repository';
import type { DepositedFileRepository } from './deposited_file_repository';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import type { DepositRequestLifecycle } from '../deposit/deposit_request_lifecycle';
import { build_activity_event } from '../domain/activity_event';
import type { Clock } from '../shared/clock';

export const CLIENT_FILE_REMOVER: unique symbol = Symbol('CLIENT_FILE_REMOVER');

export type ClientFileRemovalOutcome =
  | { kind: 'removed' }
  | { kind: 'unknown_file' }
  | { kind: 'deposit_request_is_frozen' };

export interface ClientFileRemover {
  remove(input: { access_link: AccessLink; deposited_file_id: string }): Promise<
    ClientFileRemovalOutcome
  >;
}

export interface ClientFileRemovalDependencies {
  deposit_requests: DepositRequestRepository;
  deposited_files: DepositedFileRepository;
  object_storage: ObjectStorage;
  activity_events: ActivityEventRepository;
  deposit_request_lifecycle: DepositRequestLifecycle;
  clock: Clock;
}

export class ClientFileRemovalService implements ClientFileRemover {
  constructor(private readonly dependencies: ClientFileRemovalDependencies) {}

  async remove(input: {
    access_link: AccessLink;
    deposited_file_id: string;
  }): Promise<ClientFileRemovalOutcome> {
    // L'appartenance au lien est un predicat de requete : une piece qui n'est
    // pas de ce lien-la n'est pas rendue, donc pas supprimable.
    const file: DepositedFile | null = await this.dependencies.deposited_files.find_for_access_link(
      input.deposited_file_id,
      input.access_link.id,
    );
    if (file === null) {
      return { kind: 'unknown_file' };
    }

    const view: ClientDepositRequestView | null =
      await this.dependencies.deposit_requests.find_client_view(
        input.access_link.deposit_request_id,
      );
    if (view === null) {
      return { kind: 'unknown_file' };
    }

    const plan: DepositedFileRemovalPlan = plan_deposited_file_removal(file, view.status);
    if (!plan.allowed) {
      return { kind: 'deposit_request_is_frozen' };
    }

    // La LIGNE d'abord, l'objet ensuite. L'inverse laisserait, en cas de panne
    // entre les deux, une piece visible qui ne se telecharge plus — une
    // incoherence que le client voit. Dans ce sens-ci, il ne reste qu'un objet
    // orphelin dans le bucket, invisible, et c'est precisement ce que la
    // reconciliation periodique de l'etape 6 existe pour ramasser.
    await this.dependencies.deposited_files.delete_file(file.id);

    // Journalise AVANT l'objet et APRES la ligne : c'est la disparition de la
    // ligne qui fait le retrait, et le journal doit porter la trace d'une piece
    // qu'aucune requete ne retrouvera plus jamais.
    await this.dependencies.activity_events.record(
      build_activity_event({
        deposit_request_id: input.access_link.deposit_request_id,
        type: 'deposited_file_removed',
        actor: { kind: 'client' },
        access_link_id: input.access_link.id,
        deposited_file_id: file.id,
        occurred_at: this.dependencies.clock.now(),
      }),
    );

    // Seulement si la piece etait SAINE : elle occupait alors un emplacement au
    // titre de la completude, et son depart rouvre la demande. Retirer une piece
    // infectee ou refusee ne retire rien qui comptait, et le signaler ferait
    // repasser en `incomplete` une demande que rien n'a degradee.
    if (file.status === 'clean') {
      await this.dependencies.deposit_request_lifecycle.apply_pipeline_event({
        deposit_request_id: input.access_link.deposit_request_id,
        event: 'expected_document_became_not_clean',
      });
    }

    if (plan.must_delete_stored_object) {
      await this.delete_stored_object_wherever_it_lives(file.object_key);
    }

    return { kind: 'removed' };
  }

  // La piece vit en quarantaine jusqu'a son verdict, puis dans le bucket
  // definitif. Rien ne dit lequel la porte a cet instant, et une suppression
  // partielle laisserait un fichier appartenant a un dossier qu'on croit vide.
  // La suppression etant idempotente, viser les deux ne coute qu'un appel de
  // plus et ne peut pas se tromper.
  private async delete_stored_object_wherever_it_lives(object_key: string): Promise<void> {
    for (const bucket_name of [QUARANTINE_BUCKET_NAME, VERIFIED_BUCKET_NAME]) {
      await this.dependencies.object_storage.delete_object(bucket_name, object_key);
    }
  }
}
