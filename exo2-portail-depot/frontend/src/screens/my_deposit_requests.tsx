import type { ReactElement } from 'react';
import { Flex, Heading, Stack, Text } from '@chakra-ui/react';
import { Link } from 'react-router-dom';

import type { DepositRequestOverview } from '../api/contracts';
import { use_deposit_request_overviews } from '../api/lawyer_queries';
import { LAWYER_NEW_DEPOSIT_REQUEST_PATH } from '../routing/front_routes';
import { DivCardLink } from '../ui/div_card';
import { LawyerResource } from '../ui/lawyer_resource';
import { DepositRequestStatusPill } from '../ui/status_pill';
import { format_date } from '../ui/format';
import { PrimaryButton } from '../ui/div_button';

function NewDepositRequestLink(): ReactElement {
  return (
    <Link to={LAWYER_NEW_DEPOSIT_REQUEST_PATH}>
      <PrimaryButton as="span">Faire une nouvelle demande</PrimaryButton>
    </Link>
  );
}

export function MyDepositRequestsScreen(): ReactElement {
  const overviews = use_deposit_request_overviews();

  return (
    <Stack gap="6" maxWidth="60rem" marginX="auto" paddingY="10" paddingX="4">
      <Flex justifyContent="space-between" alignItems="center" gap="4" wrap="wrap">
        <Heading size="lg">Mes demandes</Heading>
        <NewDepositRequestLink />
      </Flex>

      <LawyerResource
        query={overviews}
        loading_label="Chargement de vos demandes"
        error_message="Impossible de charger vos demandes."
        empty_message="Aucune demande en cours"
        empty_call_to_action={<NewDepositRequestLink />}
        is_empty={(requests: DepositRequestOverview[]): boolean => requests.length === 0}
      >
        {(requests: DepositRequestOverview[]) => (
          <Stack gap="3">
            {requests.map((request: DepositRequestOverview) => (
              <DepositRequestEntry key={request.id} request={request} />
            ))}
          </Stack>
        )}
      </LawyerResource>
    </Stack>
  );
}

function DepositRequestEntry({
  request,
}: {
  readonly request: DepositRequestOverview;
}): ReactElement {
  return (
    <DivCardLink to={`/deposit-requests/${request.id}`}>
      <Flex justifyContent="space-between" alignItems="center" gap="4" wrap="wrap">
        <Stack gap="1">
          <Text fontWeight="heading">{request.title}</Text>
          <Text color="gray.default">
            {request.deposited_document_count} / {request.expected_document_count} pieces
          </Text>
        </Stack>
        <Flex alignItems="center" gap="3" wrap="wrap">
          <DepositRequestStatusPill status={request.status} />
          <Text color="gray.default">{read_deadline_label(request.link_expires_at)}</Text>
        </Flex>
      </Flex>
    </DivCardLink>
  );
}

// Une demande sans lien courant n'a pas d'echeance : ecrire « — » plutot que de
// masquer la colonne garde les lignes alignees d'une demande a l'autre.
function read_deadline_label(link_expires_at: string | null): string {
  return link_expires_at === null ? 'Sans lien actif' : format_date(link_expires_at);
}
