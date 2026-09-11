import { useState, type ReactElement } from 'react';
import { Flex, Heading, Stack, Text, chakra, useRecipe } from '@chakra-ui/react';
import { Link, useParams } from 'react-router-dom';

import { ApiFailure } from '../api/api_client';
import type {
  AccessLinkDelivery,
  DepositRequestDetail,
  LawyerActivityEventView,
  LawyerActivityPage,
  LawyerExpectedDocumentView,
  PresignedDownloadTicket,
} from '../api/contracts';
import {
  use_authorize_file_download,
  use_deposit_request_activity,
  use_deposit_request_detail,
  use_regenerate_access_link,
  use_revoke_access_link,
} from '../api/lawyer_queries';
import { LAWYER_DEPOSIT_REQUESTS_PATH } from '../routing/front_routes';
import { activity_actor_label, activity_event_label } from '../ui/activity_labels';
import { PrimaryButton, SecondaryButton } from '../ui/div_button';
import { DivCard } from '../ui/div_card';
import { format_date, format_date_and_time, has_expired } from '../ui/format';
import { LawyerResource } from '../ui/lawyer_resource';
import {
  DepositRequestStatusPill,
  DepositedFileStatusPill,
  StatusPill,
  deposited_file_status_label,
} from '../ui/status_pill';
import { AccessLinkDeliveryDialog } from './access_link_delivery_dialog';
import { ConfirmationDialog } from './confirmation_dialog';

export function DepositRequestDashboardScreen(): ReactElement {
  const { deposit_request_id } = useParams<{ deposit_request_id: string }>();
  const deposit_request_key: string = deposit_request_id ?? '';
  const detail = use_deposit_request_detail(deposit_request_key);

  return (
    <Stack gap="8" maxWidth="60rem" marginX="auto" paddingY="10" paddingX="4">
      <BackToDepositRequestsLink />

      <LawyerResource
        query={detail}
        loading_label="Chargement de la demande"
        error_message="Impossible de charger cette demande."
        empty_message="Cette demande n existe plus."
        empty_call_to_action={null}
      >
        {(loaded: DepositRequestDetail) => (
          <Stack gap="8">
            <DepositRequestHeader detail={loaded} />
            <ExpectedDocumentList detail={loaded} />
            <ActivityJournal deposit_request_id={deposit_request_key} />
          </Stack>
        )}
      </LawyerResource>
    </Stack>
  );
}

// Pose AU-DESSUS de la ressource, et non dans son rendu charge : c'est quand la
// demande ne se charge pas que le cul-de-sac fait le plus mal, et un retour qui
// n'existe que sur le cas nominal ne serait pas un retour.
function BackToDepositRequestsLink(): ReactElement {
  const recipe = useRecipe({ key: 'backLink' });

  return (
    <Flex>
      <Link to={LAWYER_DEPOSIT_REQUESTS_PATH}>
        <chakra.span css={recipe()}>
          {/* La fleche est DECORATIVE : lue, elle polluerait le nom accessible
              du lien, qui doit rester exactement le titre de la page visee.
              Ecrite en echappement JS et non en entite HTML numerique : une
              telle entite a la forme d'une couleur crue, et le balayage
              lexical du theme la refuserait. */}
          <chakra.span aria-hidden="true">{'\u2190'}</chakra.span>
          Mes demandes
        </chakra.span>
      </Link>
    </Flex>
  );
}

function DepositRequestHeader({
  detail,
}: {
  readonly detail: DepositRequestDetail;
}): ReactElement {
  const regeneration = use_regenerate_access_link(detail.id);
  const revocation = use_revoke_access_link(detail.id);
  const [is_confirming_revocation, set_is_confirming_revocation] = useState<boolean>(false);
  const [regenerated, set_regenerated] = useState<AccessLinkDelivery | null>(null);

  return (
    <Stack gap="4">
      <Flex justifyContent="space-between" alignItems="center" gap="4" wrap="wrap">
        <Heading size="lg">{detail.title}</Heading>
        <DepositRequestStatusPill status={detail.status} />
      </Flex>

      <DivCard>
        <Flex justifyContent="space-between" alignItems="center" gap="4" wrap="wrap">
          <AccessLinkSummary link_expires_at={detail.link_expires_at} />
          <Flex gap="3" wrap="wrap">
            <PrimaryButton
              disabled={regeneration.isPending}
              onClick={(): void => {
                regeneration.mutate(undefined, {
                  onSuccess: (delivery: AccessLinkDelivery): void => {
                    set_regenerated(delivery);
                  },
                });
              }}
            >
              Regenerer le lien
            </PrimaryButton>
            <SecondaryButton
              disabled={detail.link_expires_at === null || revocation.isPending}
              onClick={(): void => set_is_confirming_revocation(true)}
            >
              Revoquer le lien
            </SecondaryButton>
          </Flex>
        </Flex>
      </DivCard>

      {is_confirming_revocation ? (
        <ConfirmationDialog
          title="Revoquer le lien de depot"
          consequence="Le client ne pourra plus rien deposer, et il n en sera pas averti. Regenerez un lien si vous voulez lui en redonner un."
          confirm_label="Revoquer"
          on_cancel={(): void => set_is_confirming_revocation(false)}
          on_confirm={(): void => {
            set_is_confirming_revocation(false);
            revocation.mutate();
          }}
        />
      ) : null}

      {regenerated === null ? null : (
        <AccessLinkDeliveryDialog
          deposit_request_title={detail.title}
          delivery={regenerated}
          on_close={(): void => set_regenerated(null)}
        />
      )}
    </Stack>
  );
}

function AccessLinkSummary({
  link_expires_at,
}: {
  readonly link_expires_at: string | null;
}): ReactElement {
  if (link_expires_at === null) {
    // L'URL n'est jamais reaffichable : le token n'est stocke qu'en HMAC. Il
    // n'y a donc rien a montrer d'autre que l'etat, et la sortie est la
    // regeneration.
    return <Text>Aucun lien actif. Regenerez-en un pour redonner acces au client.</Text>;
  }

  return (
    <Flex alignItems="center" gap="3" wrap="wrap">
      <Text>Lien valable jusqu au {format_date(link_expires_at)}</Text>
      {has_expired(link_expires_at) ? <StatusPill label="Lien expire" tone="danger" /> : null}
    </Flex>
  );
}

function ExpectedDocumentList({
  detail,
}: {
  readonly detail: DepositRequestDetail;
}): ReactElement {
  return (
    <Stack gap="3">
      <Heading size="md">Pieces demandees</Heading>
      <chakra.ul listStyleType="none" display="flex" flexDirection="column" gap="3">
        {detail.expected_documents.map((expected: LawyerExpectedDocumentView) => (
          <ExpectedDocumentRow
            key={expected.id}
            deposit_request_id={detail.id}
            expected={expected}
          />
        ))}
      </chakra.ul>
    </Stack>
  );
}

function ExpectedDocumentRow({
  deposit_request_id,
  expected,
}: {
  readonly deposit_request_id: string;
  readonly expected: LawyerExpectedDocumentView;
}): ReactElement {
  // Une mutation PAR LIGNE : un echec sur une piece ne doit rien dire des
  // autres, et un seul etat partage ferait clignoter le message d'erreur sur la
  // mauvaise ligne.
  const download = use_authorize_file_download(deposit_request_id);
  const deposited = expected.deposited_file;

  return (
    <chakra.li role="listitem" aria-label={expected.label}>
      <DivCard>
        {/* En colonne sur telephone, en ligne des qu'il y a la place : a
            `space-between` avec repli, la pastille de statut se retrouvait a
            droite ou en dessous SELON la longueur de l'intitule, et la colonne
            de statut cessait d'exister pour l'oeil. */}
        <Flex
          justifyContent="space-between"
          flexDirection={{ base: 'column', sm: 'row' }}
          alignItems={{ base: 'flex-start', sm: 'center' }}
          gap="4"
        >
          <Stack gap="1" minWidth="0">
            <Text fontWeight="heading">{expected.label}</Text>
            <Text color="gray.default">
              {deposited === null ? 'Aucune piece deposee' : deposited.display_filename}
            </Text>
          </Stack>
          <Flex alignItems="center" gap="3" wrap="wrap">
            <DepositedFileStatusPill status={deposited?.status ?? 'pending_upload'} />
            {deposited === null ? null : (
              <SecondaryButton
                disabled={download.isPending}
                onClick={(): void => {
                  download.mutate(deposited.id, {
                    onSuccess: (ticket: PresignedDownloadTicket): void => {
                      // Un nouvel onglet plutot qu'une navigation : l'avocat
                      // garde son dashboard ouvert pendant le telechargement.
                      window.open(ticket.download_url, '_blank');
                    },
                  });
                }}
              >
                Telecharger
              </SecondaryButton>
            )}
          </Flex>
        </Flex>
        <DownloadRefusal failure={download.error} />
      </DivCard>
    </chakra.li>
  );
}

function DownloadRefusal({ failure }: { readonly failure: ApiFailure | null }): ReactElement | null {
  if (!(failure instanceof ApiFailure)) {
    return null;
  }

  // Le 409 porte le statut REEL de la piece parce qu'elle appartient bien a cet
  // avocat : le lui cacher derriere « introuvable » ne protegerait personne et
  // l'empecherait de comprendre pourquoi il ne l'a pas.
  const message: string =
    failure.kind === 'file_not_downloadable' && failure.blocking_file_status !== null
      ? `Cette piece est ${describe_blocking_status(failure.blocking_file_status)} : elle ne peut pas etre telechargee.`
      : 'Le telechargement a echoue. Reessayez dans un instant.';

  return (
    <Text role="alert" color="danger.fg" marginTop="3">
      {message}
    </Text>
  );
}

function describe_blocking_status(status: Parameters<typeof deposited_file_status_label>[0]): string {
  return deposited_file_status_label(status).toLocaleLowerCase('fr-FR');
}

function ActivityJournal({
  deposit_request_id,
}: {
  readonly deposit_request_id: string;
}): ReactElement {
  const activity = use_deposit_request_activity(deposit_request_id);

  return (
    <Stack gap="3">
      <Heading size="md">Activite</Heading>
      <LawyerResource
        query={activity}
        loading_label="Chargement de l activite"
        error_message="Impossible de charger l activite de cette demande."
        empty_message="Rien ne s est encore produit sur cette demande."
        empty_call_to_action={null}
        is_empty={(page: LawyerActivityPage): boolean => page.events.length === 0}
      >
        {(page: LawyerActivityPage) => (
          <Stack gap="3">
            <chakra.ul
              aria-label="Activite"
              listStyleType="none"
              display="flex"
              flexDirection="column"
              gap="3"
            >
              {page.events.map((event: LawyerActivityEventView) => (
                // Trois colonnes qui se replient sans marquage rendaient le
                // journal illisible des qu'il y avait plusieurs entrees :
                // l'acteur d'une ligne finissait colle a la date de la suivante,
                // et rien ne disait ou commencait une entree. Le libelle porte
                // desormais l'entree, l'heure et l'acteur la commentent en
                // dessous, et un filet les separe.
                <chakra.li
                  key={event.id}
                  borderLeftWidth="2px"
                  borderColor="border"
                  paddingLeft="3"
                >
                  <Stack gap="0.5">
                    <Text>{activity_event_label(event.type)}</Text>
                    <Flex gap="2" wrap="wrap" color="gray.default" fontSize="sm">
                      <Text>{format_date_and_time(event.occurred_at)}</Text>
                      <Text aria-hidden="true">—</Text>
                      <Text>{activity_actor_label(event.actor)}</Text>
                    </Flex>
                  </Stack>
                </chakra.li>
              ))}
            </chakra.ul>

            {page.has_more ? (
              // L'API rend `has_more` mais aucun curseur : offrir « Voir plus »
              // serait promettre une page qui n'existe pas.
              <Text color="gray.default">
                Il existe de l activite plus ancienne, non affichee ici.
              </Text>
            ) : null}
          </Stack>
        )}
      </LawyerResource>
    </Stack>
  );
}
