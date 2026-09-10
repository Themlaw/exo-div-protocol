import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { ApiFailure } from '../api/api_client';
import { LAWYER_LOGIN_PATH } from '../routing/front_routes';
import { ResourceStates, type ResourceState } from './resource_states';

export interface LawyerResourceProps<Item> {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: ApiFailure | null;
    readonly data: Item | undefined;
    readonly refetch: () => unknown;
  };
  readonly loading_label: string;
  readonly error_message: string;
  readonly empty_message: string;
  readonly empty_call_to_action: ReactNode;
  readonly is_empty?: (data: Item) => boolean;
  readonly children: (data: Item) => ReactNode;
}

// Le seul endroit ou une session expiree est traduite en navigation. Laisser
// chaque ecran s'en charger, c'est garantir qu'un ecran l'oubliera et affichera
// « Reessayer » sur un 401 — un bouton qui fera tourner l'avocat en rond.
export function LawyerResource<Item>({
  query,
  loading_label,
  error_message,
  empty_message,
  empty_call_to_action,
  is_empty,
  children,
}: LawyerResourceProps<Item>): ReactElement {
  if (query.error instanceof ApiFailure && query.error.kind === 'unauthenticated') {
    return <Navigate to={LAWYER_LOGIN_PATH} replace />;
  }

  const state: ResourceState = read_resource_state(query, is_empty);

  return (
    <ResourceStates
      state={state}
      loading_label={loading_label}
      error_message={error_message}
      on_retry={(): void => {
        void query.refetch();
      }}
      empty_message={empty_message}
      empty_call_to_action={empty_call_to_action}
    >
      {query.data === undefined ? null : children(query.data)}
    </ResourceStates>
  );
}

function read_resource_state<Item>(
  query: LawyerResourceProps<Item>['query'],
  is_empty: ((data: Item) => boolean) | undefined,
): ResourceState {
  if (query.isPending) {
    return 'loading';
  }

  if (query.isError || query.data === undefined) {
    return 'error';
  }

  return is_empty !== undefined && is_empty(query.data) ? 'empty' : 'ready';
}
