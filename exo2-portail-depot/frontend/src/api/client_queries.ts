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
  ClientDepositBoardView,
  ClientUploadTicketView,
  DepositRequestStatus,
  PublicAccessLinkView,
} from './contracts';

export const CLIENT_QUERY_KEYS = {
  public_link: (token: string): readonly unknown[] => ['public', token],
  deposit_board: (token: string): readonly unknown[] => ['public', token, 'documents'],
} as const;

export function use_public_link_state(token: string): UseQueryResult<
  PublicAccessLinkView,
  ApiFailure
> {
  return useQuery<PublicAccessLinkView, ApiFailure>({
    queryKey: CLIENT_QUERY_KEYS.public_link(token),
    queryFn: (): Promise<PublicAccessLinkView> =>
      request_api<PublicAccessLinkView>(`/public/${token}`),
  });
}

// Tant qu'une piece n'a pas rendu son verdict, le tableau est relu : l'objet
// passe par MinIO, un webhook, puis un scan, et le client n'a aucun autre moyen
// d'apprendre que sa piece est acceptee. L'intervalle s'arrete de lui-meme des
// que plus rien ne bouge.
const UNSETTLED_BOARD_REFETCH_INTERVAL_MS = 3_000;

export function use_client_deposit_board(
  token: string,
): UseQueryResult<ClientDepositBoardView, ApiFailure> {
  return useQuery<ClientDepositBoardView, ApiFailure>({
    queryKey: CLIENT_QUERY_KEYS.deposit_board(token),
    queryFn: (): Promise<ClientDepositBoardView> =>
      request_api<ClientDepositBoardView>(`/public/${token}/documents`),
    refetchInterval: (query): number | false =>
      query.state.data !== undefined && has_unsettled_document(query.state.data)
        ? UNSETTLED_BOARD_REFETCH_INTERVAL_MS
        : false,
  });
}

export function has_unsettled_document(board: ClientDepositBoardView): boolean {
  return board.expected_documents.some(
    (document) =>
      document.deposited_file !== null &&
      (document.deposited_file.status === 'pending_upload' ||
        document.deposited_file.status === 'pending_scan'),
  );
}

export function use_unlock_deposit_link(
  token: string,
): UseMutationResult<{ expires_at: string }, ApiFailure, string> {
  const query_client: QueryClient = useQueryClient();

  return useMutation<{ expires_at: string }, ApiFailure, string>({
    mutationFn: (submitted_pin: string): Promise<{ expires_at: string }> =>
      request_api<{ expires_at: string }>(`/public/${token}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: submitted_pin }),
      }),
    onSuccess: (): void => {
      // Le cookie de session vient d'arriver : c'est la relecture du tableau qui
      // fait basculer l'ecran, et non un drapeau local qu'un rechargement
      // perdrait.
      void query_client.invalidateQueries({ queryKey: CLIENT_QUERY_KEYS.deposit_board(token) });
    },
  });
}

export interface UploadAuthorizationRequest {
  readonly expected_document_id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
}

export function use_authorize_upload(
  token: string,
): UseMutationResult<ClientUploadTicketView, ApiFailure, UploadAuthorizationRequest> {
  return useMutation<ClientUploadTicketView, ApiFailure, UploadAuthorizationRequest>({
    mutationFn: (authorization: UploadAuthorizationRequest): Promise<ClientUploadTicketView> =>
      request_api<ClientUploadTicketView>(`/public/${token}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authorization),
      }),
  });
}

export function use_remove_deposited_file(
  token: string,
): UseMutationResult<void, ApiFailure, string> {
  const query_client: QueryClient = useQueryClient();

  return useMutation<void, ApiFailure, string>({
    mutationFn: (deposited_file_id: string): Promise<void> =>
      request_api<void>(`/public/${token}/files/${deposited_file_id}`, { method: 'DELETE' }),
    onSuccess: (): void => {
      void query_client.invalidateQueries({ queryKey: CLIENT_QUERY_KEYS.deposit_board(token) });
    },
  });
}

export function use_complete_deposit(
  token: string,
): UseMutationResult<{ status: DepositRequestStatus }, ApiFailure, void> {
  const query_client: QueryClient = useQueryClient();

  return useMutation<{ status: DepositRequestStatus }, ApiFailure, void>({
    mutationFn: (): Promise<{ status: DepositRequestStatus }> =>
      request_api<{ status: DepositRequestStatus }>(`/public/${token}/completion`, {
        method: 'POST',
      }),
    onSuccess: (): void => {
      void query_client.invalidateQueries({ queryKey: CLIENT_QUERY_KEYS.deposit_board(token) });
    },
  });
}
