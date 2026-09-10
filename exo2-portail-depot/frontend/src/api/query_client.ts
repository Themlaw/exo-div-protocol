import { QueryClient } from '@tanstack/react-query';

import { ApiFailure } from './api_client';

// Rejouer un 400, un 401, un 404 ou un 409 ne change rien a la reponse : cela ne fait
// que retarder de plusieurs secondes le message que l'avocat doit lire. Seule
// une panne de transport merite d'etre retentee.
const RETRYABLE_FAILURE_KINDS: readonly string[] = ['network_unavailable', 'unexpected'];
const MAXIMUM_RETRY_COUNT = 2;

export function create_query_client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failure_count: number, error: unknown): boolean => {
          if (!(error instanceof ApiFailure)) {
            return false;
          }

          return (
            RETRYABLE_FAILURE_KINDS.includes(error.kind) && failure_count < MAXIMUM_RETRY_COUNT
          );
        },
        // Le tableau de bord suit un scan antiviral qui avance en arriere-plan :
        // revenir sur l'onglet doit montrer l'etat courant, pas celui d'il y a
        // dix minutes.
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
