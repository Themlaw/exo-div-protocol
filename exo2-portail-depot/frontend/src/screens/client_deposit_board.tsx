import { useEffect, useState, type ChangeEvent, type ReactElement } from 'react';
import { Flex, Heading, Stack, Text, chakra, useRecipe } from '@chakra-ui/react';

import { ApiFailure } from '../api/api_client';
import type {
  ClientDepositBoardView,
  ClientExpectedDocumentView,
  ClientUploadTicketView,
} from '../api/contracts';
import {
  use_authorize_upload,
  use_complete_deposit,
  use_remove_deposited_file,
} from '../api/client_queries';
import {
  ObjectStorageUploadError,
  upload_to_object_storage,
  type UploadProgress,
} from '../api/object_storage_upload';
import { PrimaryButton, SecondaryButton } from '../ui/div_button';
import { DivCard } from '../ui/div_card';
import { format_date_and_time, format_megabytes, format_mime_types } from '../ui/format';
import { DepositedFileStatusPill } from '../ui/status_pill';
import { ConfirmationDialog } from './confirmation_dialog';

export interface ClientDepositBoardProps {
  readonly token: string;
  readonly board: ClientDepositBoardView;
  readonly on_upload_finished: (expected_document_id: string) => void;
  readonly on_arrival_observed: (expected_document_id: string) => void;
}

export function ClientDepositBoard({
  token,
  board,
  on_upload_finished,
  on_arrival_observed,
}: ClientDepositBoardProps): ReactElement {
  // Une fois la demande partie en traitement, elle appartient au dossier de
  // l'avocat : plus rien ne s'ajoute ni ne se retire, sinon ce qu'il examine
  // changerait sous ses yeux.
  const is_frozen: boolean = board.deposit_request_status !== 'incomplete';

  return (
    <Stack gap="6">
      <Stack gap="2">
        <Heading size="lg">{board.title}</Heading>
        <Text color="gray.default">
          Votre acces reste ouvert jusqu a {format_date_and_time(board.session_expires_at)}.
        </Text>
      </Stack>

      {is_frozen ? (
        <Text role="status">
          Votre depot a ete transmis. Les pieces ne peuvent plus etre modifiees.
        </Text>
      ) : null}

      <chakra.ul listStyleType="none" display="flex" flexDirection="column" gap="3">
        {board.expected_documents.map((expected: ClientExpectedDocumentView) => (
          <DepositSlot
            key={expected.id}
            token={token}
            expected={expected}
            is_frozen={is_frozen}
            on_upload_finished={on_upload_finished}
            on_arrival_observed={on_arrival_observed}
          />
        ))}
      </chakra.ul>

      {is_frozen ? null : <CompletionFooter token={token} board={board} />}
    </Stack>
  );
}

function DepositSlot({
  token,
  expected,
  is_frozen,
  on_upload_finished,
  on_arrival_observed,
}: {
  readonly token: string;
  readonly expected: ClientExpectedDocumentView;
  readonly is_frozen: boolean;
  readonly on_upload_finished: (expected_document_id: string) => void;
  readonly on_arrival_observed: (expected_document_id: string) => void;
}): ReactElement {
  const [chosen_file, set_chosen_file] = useState<File | null>(null);
  const [progress, set_progress] = useState<UploadProgress | null>(null);
  const [transport_failure, set_transport_failure] = useState<ObjectStorageUploadError | null>(
    null,
  );
  const [is_confirming_removal, set_is_confirming_removal] = useState<boolean>(false);
  const [has_finished_its_upload, set_has_finished_its_upload] = useState<boolean>(false);
  // Une autorisation PAR EMPLACEMENT : un echec sur une piece ne doit rien dire
  // des autres, et un etat partage ferait clignoter le message sur la mauvaise
  // ligne.
  const authorization = use_authorize_upload(token);
  const removal = use_remove_deposited_file(token);
  const deposited = expected.deposited_file;
  const is_awaiting_arrival: boolean = has_finished_its_upload && deposited === null;

  useEffect((): void => {
    if (has_finished_its_upload && deposited !== null) {
      set_has_finished_its_upload(false);
      on_arrival_observed(expected.id);
    }
  }, [has_finished_its_upload, deposited, expected.id, on_arrival_observed]);

  async function send_the_chosen_file(): Promise<void> {
    if (chosen_file === null) {
      return;
    }

    set_transport_failure(null);
    set_progress({ transferred_bytes: 0, total_bytes: chosen_file.size });

    try {
      const ticket: ClientUploadTicketView = await authorization.mutateAsync({
        expected_document_id: expected.id,
        filename: chosen_file.name,
        mime_type: chosen_file.type,
        size_bytes: chosen_file.size,
      });

      await upload_to_object_storage({ ticket, file: chosen_file, on_progress: set_progress });
      set_chosen_file(null);
      // La barre a fini son travail : la laisser pleine a l'ecran pendant
      // l'analyse, puis apres le depot, en ferait un ornement qui ne mesure plus
      // rien. C'est « Reception de la piece en cours… » qui dit la suite.
      set_progress(null);
      // Les octets sont partis, et pourtant l'emplacement est encore vide aux
      // yeux du serveur : il ne comptera la piece qu'au passage du webhook. Le
      // dire au client evite qu'il croie son envoi perdu et recommence.
      set_has_finished_its_upload(true);
      on_upload_finished(expected.id);
    } catch (failure: unknown) {
      set_progress(null);

      if (failure instanceof ObjectStorageUploadError) {
        set_transport_failure(failure);
      }
    }
  }

  return (
    <chakra.li role="listitem" aria-label={expected.label}>
      <DivCard>
        <Stack gap="3">
          <Flex justifyContent="space-between" alignItems="center" gap="4" wrap="wrap">
            <Stack gap="1">
              <Text fontWeight="heading">{expected.label}</Text>
              <Text color="gray.default">
                {format_mime_types(expected.allowed_mime_types)} — au plus{' '}
                {format_megabytes(expected.max_size_bytes)}
              </Text>
            </Stack>
            {deposited === null ? null : <DepositedFileStatusPill status={deposited.status} />}
          </Flex>

          {deposited === null ? (
            <UploadControls
              expected={expected}
              chosen_file={chosen_file}
              // `has_finished_its_upload` compte AUSSI : entre la fin du
              // transfert et l'arrivee de la piece, rouvrir la selection
              // inviterait le client a envoyer deux fois le meme document.
              is_sending={
                authorization.isPending || progress !== null || has_finished_its_upload
              }
              is_frozen={is_frozen}
              on_choose={set_chosen_file}
              on_send={(): void => {
                void send_the_chosen_file();
              }}
            />
          ) : (
            <Flex justifyContent="space-between" alignItems="center" gap="4" wrap="wrap">
              <Text>{deposited.display_filename}</Text>
              <SecondaryButton
                disabled={is_frozen || removal.isPending}
                onClick={(): void => set_is_confirming_removal(true)}
              >
                Retirer
              </SecondaryButton>
            </Flex>
          )}

          {progress === null ? null : <UploadProgressBar progress={progress} />}

          {is_awaiting_arrival ? (
            <Text role="status">Envoi termine. Reception de la piece en cours…</Text>
          ) : null}

          <SlotFailure
            authorization_failure={authorization.error}
            transport_failure={transport_failure}
            removal_failure={removal.error}
          />
        </Stack>
      </DivCard>

      {is_confirming_removal && deposited !== null ? (
        <ConfirmationDialog
          title="Retirer cette piece"
          consequence={`« ${deposited.display_filename} » sera definitivement supprimee, et l emplacement redeviendra vide.`}
          confirm_label="Retirer"
          on_cancel={(): void => set_is_confirming_removal(false)}
          on_confirm={(): void => {
            set_is_confirming_removal(false);
            removal.mutate(deposited.id);
          }}
        />
      ) : null}
    </chakra.li>
  );
}

function UploadControls({
  expected,
  chosen_file,
  is_sending,
  is_frozen,
  on_choose,
  on_send,
}: {
  readonly expected: ClientExpectedDocumentView;
  readonly chosen_file: File | null;
  readonly is_sending: boolean;
  readonly is_frozen: boolean;
  readonly on_choose: (file: File | null) => void;
  readonly on_send: () => void;
}): ReactElement {
  const file_chooser = useRecipe({ key: 'fileChooser' });

  return (
    <Flex gap="3" alignItems="center" wrap="wrap">
      <Stack gap="1" flex="1 1 12rem" minWidth="0">
        {/* Le label HABILLE l'input, il ne le remplace pas : l'input reste dans
            le DOM, porte le nom accessible et ouvre le selecteur. Le masquer
            visuellement plutot que le retirer garde intacts le clavier, les
            lecteurs d'ecran et les tests qui le designent par ce nom. */}
        <chakra.label css={file_chooser()}>
          {/* La selection est LOCALE, sans reseau : changer d'avis avant
              d'appuyer ne coute rien et n'annule aucun transfert. */}
          <chakra.input
            type="file"
            srOnly
            aria-label={`Choisir un fichier pour ${expected.label}`}
            accept={expected.allowed_mime_types.join(',')}
            disabled={is_frozen || is_sending}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              on_choose(event.target.files?.[0] ?? null);
            }}
          />
          {chosen_file === null ? 'Choisir un fichier' : 'Changer de fichier'}
        </chakra.label>

        {/* Le nom du fichier choisi, que le controle natif affichait seul. Sans
            lui le client ne peut plus verifier qu'il envoie le bon document. */}
        {chosen_file === null ? null : (
          <Text fontSize="sm" color="gray.default" truncate>
            {chosen_file.name}
          </Text>
        )}
      </Stack>

      <PrimaryButton
        disabled={chosen_file === null || is_sending || is_frozen}
        aria-label={`Envoyer ${expected.label}`}
        onClick={on_send}
      >
        Envoyer
      </PrimaryButton>
    </Flex>
  );
}

function UploadProgressBar({ progress }: { readonly progress: UploadProgress }): ReactElement {
  const percentage: number =
    progress.total_bytes === 0
      ? 0
      : Math.round((progress.transferred_bytes / progress.total_bytes) * 100);

  return (
    <chakra.div
      role="progressbar"
      aria-label="Progression de l envoi"
      aria-valuenow={percentage}
      aria-valuemin={0}
      aria-valuemax={100}
      bg="accent.surface"
      borderRadius="full"
      height="8px"
      overflow="hidden"
    >
      <chakra.div bg="primary" height="100%" width={`${String(percentage)}%`} />
    </chakra.div>
  );
}

function SlotFailure({
  authorization_failure,
  transport_failure,
  removal_failure,
}: {
  readonly authorization_failure: ApiFailure | null;
  readonly transport_failure: ObjectStorageUploadError | null;
  readonly removal_failure: ApiFailure | null;
}): ReactElement | null {
  const message: string | null =
    describe_authorization_failure(authorization_failure) ??
    (transport_failure === null
      ? null
      : 'L envoi a ete interrompu. Reessayez : rien n a ete conserve.') ??
    describe_removal_failure(removal_failure);

  return message === null ? null : (
    <Text role="alert" color="danger.fg">
      {message}
    </Text>
  );
}

function describe_authorization_failure(failure: ApiFailure | null): string | null {
  if (!(failure instanceof ApiFailure)) {
    return null;
  }

  // Les deux seuls refus que le backend EXPLIQUE sont ceux auxquels le client
  // peut remedier : il rend la limite reelle et la liste des formats, et les
  // recopier ici serait les laisser diverger.
  if (failure.kind === 'refused_upload' && failure.upload_refusal !== null) {
    return failure.upload_refusal.reason === 'declared_size_above_limit'
      ? `Ce fichier depasse la taille autorisee pour cet emplacement (${format_megabytes(failure.upload_refusal.max_size_bytes)}).`
      : `Ce format n est pas accepte ici. Formats autorises : ${format_mime_types(failure.upload_refusal.allowed_mime_types)}.`;
  }

  if (failure.kind === 'conflict') {
    return 'Une piece occupe deja cet emplacement : retirez-la avant d en deposer une autre.';
  }

  if (failure.kind === 'rate_limited') {
    return 'Trop d envois pour cette session. Rouvrez le lien avec votre code.';
  }

  return 'L envoi a echoue. Reessayez dans un instant.';
}

function describe_removal_failure(failure: ApiFailure | null): string | null {
  if (!(failure instanceof ApiFailure)) {
    return null;
  }

  return failure.kind === 'conflict'
    ? 'Ce depot est en cours de traitement : les pieces ne peuvent plus etre retirees.'
    : 'Le retrait a echoue. Reessayez dans un instant.';
}

function CompletionFooter({
  token,
  board,
}: {
  readonly token: string;
  readonly board: ClientDepositBoardView;
}): ReactElement {
  const [is_confirming, set_is_confirming] = useState<boolean>(false);
  const completion = use_complete_deposit(token);
  const empty_slot_count: number = board.expected_documents.filter(
    (expected: ClientExpectedDocumentView) => expected.deposited_file === null,
  ).length;

  return (
    <Stack gap="3">
      <Flex justifyContent="flex-end">
        <PrimaryButton disabled={completion.isPending} onClick={(): void => set_is_confirming(true)}>
          Terminer le depot
        </PrimaryButton>
      </Flex>

      {completion.error instanceof ApiFailure ? (
        <Text role="alert" color="danger.fg">
          {completion.error.kind === 'conflict'
            ? 'Ce depot ne peut plus etre termine. Rechargez la page pour voir son etat.'
            : 'La transmission a echoue. Reessayez dans un instant.'}
        </Text>
      ) : null}

      {is_confirming ? (
        <ConfirmationDialog
          title="Terminer le depot"
          // Le manque est NOMME plutot qu'interdit : le client a parfois une
          // bonne raison — un document qu'il n'aura jamais — et l'avocat verra
          // la demande arriver incomplete, avec son journal.
          consequence={describe_completion_consequence(empty_slot_count)}
          confirm_label="Terminer"
          on_cancel={(): void => set_is_confirming(false)}
          on_confirm={(): void => {
            set_is_confirming(false);
            completion.mutate();
          }}
        />
      ) : null}
    </Stack>
  );
}

function describe_completion_consequence(empty_slot_count: number): string {
  const frozen_warning =
    'Vos pieces seront transmises a votre avocat et vous ne pourrez plus les modifier.';

  return empty_slot_count === 0
    ? frozen_warning
    : `${String(empty_slot_count)} emplacement${empty_slot_count > 1 ? 's sont vides' : ' est vide'}. ${frozen_warning}`;
}
