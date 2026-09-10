import type { ReactElement } from 'react';
import { Stack } from '@chakra-ui/react';
import { useParams } from 'react-router-dom';

import { ApiFailure } from '../api/api_client';
import { use_client_deposit_board } from '../api/client_queries';
import { ClientDepositBoard } from './client_deposit_board';
import { ClientLinkGate } from './client_link_gate';
import { ResourceStates } from '../ui/resource_states';

// L'ecran ne retient AUCUN drapeau « deverrouille » : c'est la reponse de
// `/documents` qui tranche. Le cookie de session est HttpOnly, donc invisible du
// JavaScript, et un drapeau local mentirait des le rechargement de la page — ou
// survivrait a l'expiration de la session.
export function ClientDepositScreen(): ReactElement {
  const { token } = useParams<{ token: string }>();
  const link_token: string = token ?? '';
  const board = use_client_deposit_board(link_token);

  if (board.error instanceof ApiFailure && board.error.kind === 'unauthenticated') {
    return <ClientLinkGate token={link_token} />;
  }

  return (
    <Stack gap="6" maxWidth="46rem" marginX="auto" paddingY="10" paddingX="4">
      <ResourceStates
        state={board.isPending ? 'loading' : board.isError ? 'error' : 'ready'}
        loading_label="Ouverture de votre depot"
        error_message="Impossible de charger votre depot. Verifiez votre connexion."
        on_retry={(): void => {
          void board.refetch();
        }}
        empty_message=""
        empty_call_to_action={null}
      >
        {board.data === undefined ? null : (
          <ClientDepositBoard token={link_token} board={board.data} />
        )}
      </ResourceStates>
    </Stack>
  );
}
