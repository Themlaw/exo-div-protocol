import { useCallback, useState, type ReactElement } from 'react';
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
  // Les emplacements dont les octets sont partis vers MinIO mais que le serveur
  // ne compte pas encore. Ils ne se lisent nulle part dans la reponse — le
  // webhook ne les a pas encore fait exister — et c'est pourtant pendant CE
  // moment-la que le tableau doit etre relu.
  const [slots_awaiting_arrival, set_slots_awaiting_arrival] = useState<readonly string[]>([]);
  const board = use_client_deposit_board(link_token, slots_awaiting_arrival.length > 0);

  const mark_slot_as_awaiting_arrival = useCallback((expected_document_id: string): void => {
    set_slots_awaiting_arrival((current: readonly string[]) =>
      current.includes(expected_document_id) ? current : [...current, expected_document_id],
    );
  }, []);

  const forget_slot_awaiting_arrival = useCallback((expected_document_id: string): void => {
    set_slots_awaiting_arrival((current: readonly string[]) =>
      current.filter((awaiting: string) => awaiting !== expected_document_id),
    );
  }, []);

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
          <ClientDepositBoard
            token={link_token}
            board={board.data}
            on_upload_finished={mark_slot_as_awaiting_arrival}
            on_arrival_observed={forget_slot_awaiting_arrival}
          />
        )}
      </ResourceStates>
    </Stack>
  );
}
