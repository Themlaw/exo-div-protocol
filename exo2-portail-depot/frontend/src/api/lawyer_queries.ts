import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { request_api, type ApiFailure } from './api_client';
import type {
  AccessLinkDelivery,
  DepositRequestDetail,
  DepositRequestOverview,
  LawyerActivityPage,
  PresignedDownloadTicket,
  SecurityPolicy,
} from './contracts';

// Les clefs sont hierarchiques — ['requests'], ['requests', id], ['requests',
// id, 'activity'] — pour qu'invalider une demande invalide aussi son journal
// sans avoir a les enumerer.
export const LAWYER_QUERY_KEYS = {
  deposit_requests: (): readonly unknown[] => ['requests'],
  deposit_request: (deposit_request_id: string): readonly unknown[] => [
    'requests',
    deposit_request_id,
  ],
  deposit_request_activity: (deposit_request_id: string): readonly unknown[] => [
    'requests',
    deposit_request_id,
    'activity',
  ],
} as const;

export function use_deposit_request_overviews(): UseQueryResult<
  DepositRequestOverview[],
  ApiFailure
> {
  return useQuery<DepositRequestOverview[], ApiFailure>({
    queryKey: LAWYER_QUERY_KEYS.deposit_requests(),
    queryFn: (): Promise<DepositRequestOverview[]> =>
      request_api<DepositRequestOverview[]>('/requests'),
  });
}

export function use_deposit_request_detail(
  deposit_request_id: string,
): UseQueryResult<DepositRequestDetail, ApiFailure> {
  return useQuery<DepositRequestDetail, ApiFailure>({
    queryKey: LAWYER_QUERY_KEYS.deposit_request(deposit_request_id),
    queryFn: (): Promise<DepositRequestDetail> =>
      request_api<DepositRequestDetail>(`/requests/${deposit_request_id}`),
  });
}

export function use_deposit_request_activity(
  deposit_request_id: string,
): UseQueryResult<LawyerActivityPage, ApiFailure> {
  return useQuery<LawyerActivityPage, ApiFailure>({
    queryKey: LAWYER_QUERY_KEYS.deposit_request_activity(deposit_request_id),
    queryFn: (): Promise<LawyerActivityPage> =>
      request_api<LawyerActivityPage>(`/requests/${deposit_request_id}/activity`),
  });
}

export interface DepositRequestCreationBody {
  readonly title: string;
  readonly expected_documents: readonly {
    readonly label: string;
    readonly position: number;
    readonly allowed_mime_types: readonly string[];
    readonly max_size_bytes: number;
  }[];
  // Facultative cote backend, TOUJOURS envoyee ici : le formulaire montre a
  // l'avocat les trois valeurs qui partiront, et omettre le champ ferait
  // dependre le resultat d'un defaut qu'il ne voit pas.
  readonly security_policy: SecurityPolicy;
}

export interface DepositRequestCreationResult {
  readonly id: string;
  readonly access_link: AccessLinkDelivery;
}

export function use_create_deposit_request(): UseMutationResult<
  DepositRequestCreationResult,
  ApiFailure,
  DepositRequestCreationBody
> {
  const query_client: QueryClient = useQueryClient();

  return useMutation<DepositRequestCreationResult, ApiFailure, DepositRequestCreationBody>({
    mutationFn: (body: DepositRequestCreationBody): Promise<DepositRequestCreationResult> =>
      request_api<DepositRequestCreationResult>('/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (): void => {
      void query_client.invalidateQueries({ queryKey: LAWYER_QUERY_KEYS.deposit_requests() });
    },
  });
}

export function use_regenerate_access_link(
  deposit_request_id: string,
): UseMutationResult<AccessLinkDelivery, ApiFailure, void> {
  const query_client: QueryClient = useQueryClient();

  return useMutation<AccessLinkDelivery, ApiFailure, void>({
    mutationFn: (): Promise<AccessLinkDelivery> =>
      request_api<AccessLinkDelivery>(`/requests/${deposit_request_id}/links`, {
        method: 'POST',
      }),
    onSuccess: (): void => {
      void query_client.invalidateQueries({
        queryKey: LAWYER_QUERY_KEYS.deposit_request(deposit_request_id),
      });
    },
  });
}

export function use_revoke_access_link(
  deposit_request_id: string,
): UseMutationResult<void, ApiFailure, void> {
  const query_client: QueryClient = useQueryClient();

  return useMutation<void, ApiFailure, void>({
    mutationFn: (): Promise<void> =>
      request_api<void>(`/requests/${deposit_request_id}/links/current`, {
        method: 'DELETE',
      }),
    onSuccess: (): void => {
      void query_client.invalidateQueries({
        queryKey: LAWYER_QUERY_KEYS.deposit_request(deposit_request_id),
      });
    },
  });
}

// Le telechargement est une MUTATION et non une requete : il journalise un
// evenement `deposited_file_downloaded` cote serveur, donc le rejouer au
// remontage d'un composant salirait le journal du dossier.
export function use_authorize_file_download(
  deposit_request_id: string,
): UseMutationResult<PresignedDownloadTicket, ApiFailure, string> {
  return useMutation<PresignedDownloadTicket, ApiFailure, string>({
    mutationFn: (deposited_file_id: string): Promise<PresignedDownloadTicket> =>
      request_api<PresignedDownloadTicket>(
        `/requests/${deposit_request_id}/files/${deposited_file_id}/download`,
      ),
  });
}
