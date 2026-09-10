import type {
  ClientDepositRequestView,
  DepositRequestCompletion,
  DepositRequestDetail,
  DepositRequestOverview,
  DepositRequestRepository,
  DepositRequestStatusTransition,
} from '../../src/deposit/deposit_request_repository';
import type { DepositRequestStatus } from '../../src/domain/deposit_request_status';

// Ne double QUE le cycle de vie : les lectures de vue ne sont pas le sujet des
// tests qui l'utilisent, et un double qui les simulerait ferait croire qu'elles
// sont couvertes ici.
export class FakeDepositRequestRepository implements DepositRequestRepository {
  readonly statuses = new Map<string, DepositRequestStatus>();
  readonly completions = new Map<string, DepositRequestCompletion>();
  // Les demandes que le balayage doit constater expirees, avec l'instant a
  // partir duquel elles le sont : la vraie requete compare l'echeance du lien a
  // l'horloge, et un double qui rendrait tout sans condition ne dirait pas si
  // l'appelant a bien passe son instant.
  readonly expired_at_instant = new Map<string, Date>();
  // Compte les transitions TENTEES, y compris celles qui ne changent rien :
  // c'est ce qui permet d'affirmer qu'un appelant a bien consulte la machine
  // plutot que d'avoir devine le resultat.
  transition_attempt_count = 0;

  seed(deposit_request_id: string, status: DepositRequestStatus): void {
    this.statuses.set(deposit_request_id, status);
  }

  seed_completion(deposit_request_id: string, completion: DepositRequestCompletion): void {
    this.completions.set(deposit_request_id, completion);
  }

  seed_expired(deposit_request_id: string, expires_at: Date): void {
    this.expired_at_instant.set(deposit_request_id, expires_at);
  }

  async apply_status_transition(
    deposit_request_id: string,
    decide: (current: DepositRequestStatus) => DepositRequestStatus,
  ): Promise<DepositRequestStatusTransition | null> {
    const status_before: DepositRequestStatus | undefined =
      this.statuses.get(deposit_request_id);
    if (status_before === undefined) {
      return null;
    }

    this.transition_attempt_count += 1;
    const status_after: DepositRequestStatus = decide(status_before);
    this.statuses.set(deposit_request_id, status_after);

    return { status_before, status_after };
  }

  async read_completion(deposit_request_id: string): Promise<DepositRequestCompletion> {
    return (
      this.completions.get(deposit_request_id) ?? {
        expected_document_count: 0,
        clean_expected_document_count: 0,
      }
    );
  }

  async list_incomplete_with_expired_link(instant: Date): Promise<string[]> {
    return [...this.expired_at_instant.entries()]
      .filter(([, expires_at]: [string, Date]): boolean => expires_at.getTime() <= instant.getTime())
      .map(([deposit_request_id]: [string, Date]): string => deposit_request_id);
  }

  async create(): Promise<string> {
    throw new Error('non double : ce test ne cree pas de demande');
  }

  async list_overviews_for_owner(): Promise<DepositRequestOverview[]> {
    throw new Error('non double : ce test ne lit pas la liste');
  }

  async belongs_to_owner(): Promise<boolean> {
    throw new Error('non double : ce test ne verifie pas l appartenance');
  }

  async find_detail_for_owner(): Promise<DepositRequestDetail | null> {
    throw new Error('non double : ce test ne lit pas le detail');
  }

  // Le seul « non double » a porter son parametre : un test qui a besoin de la
  // vue derive celle-ci du statut seme, et une signature vide lui interdirait
  // de la surcharger.
  async find_client_view(_deposit_request_id: string): Promise<ClientDepositRequestView | null> {
    throw new Error('non double : ce test ne lit pas la vue client');
  }
}
