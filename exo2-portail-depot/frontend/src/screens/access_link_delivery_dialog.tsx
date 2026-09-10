import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Box, Flex, Heading, Stack, Text, chakra, useRecipe } from '@chakra-ui/react';

import type { AccessLinkDelivery } from '../api/contracts';
import { PrimaryButton } from '../ui/div_button';
import { format_date_and_time } from '../ui/format';

const UNCOPIED_WARNING =
  'Vous n avez pas copie le message. Fermer maintenant le perdra definitivement.';

const COPY_FAILURE_MESSAGE =
  'La copie a echoue : votre navigateur refuse l acces au presse-papier. Selectionnez le message ci-dessus et copiez-le a la main.';

// L'issue de la DERNIERE tentative de copie, et rien d'autre : « je n'ai pas
// encore essaye » et « j'ai essaye, ca a rate » ne se disent pas de la meme
// facon a l'avocat.
type CopyOutcome = 'untouched' | 'copied' | 'failed';

// Le libelle de repos est aussi celui de l'echec : apres un refus, le bouton
// doit inviter a RECOMMENCER, pas afficher un constat. Seul le succes change de
// mot — et c'est ce mot qui manquait a l'ecran.
const COPY_BUTTON_LABELS: Readonly<Record<CopyOutcome, string>> = {
  untouched: 'Copier le message',
  copied: 'Message copie',
  failed: 'Copier le message',
};

// Assez long pour etre lu par quelqu'un qui regardait ailleurs au moment du
// clic, assez court pour que le bouton redevienne une invitation a recopier si
// l'avocat en a besoin.
const COPY_FEEDBACK_DURATION_MS = 4000;

export interface AccessLinkDeliveryDialogProps {
  readonly deposit_request_title: string;
  readonly delivery: AccessLinkDelivery;
  readonly on_close: () => void;
}

// `alertdialog` et non `dialog` : le contenu est un avertissement, et c'est le
// role qui fait annoncer le message avant les boutons par un lecteur d'ecran.
//
// Le couple lien + code n'existe QUE dans cette reponse : le PIN est hache et
// le token n'est stocke qu'en HMAC, le serveur est incapable de les redire.
export function AccessLinkDeliveryDialog({
  deposit_request_title,
  delivery,
  on_close,
}: AccessLinkDeliveryDialogProps): ReactElement {
  const [has_been_copied, set_has_been_copied] = useState<boolean>(false);
  const [is_warned_about_closing, set_is_warned_about_closing] = useState<boolean>(false);

  function attempt_to_close(): void {
    if (has_been_copied || is_warned_about_closing) {
      on_close();

      return;
    }

    set_is_warned_about_closing(true);
  }

  return (
    <Flex
      position="fixed"
      inset="0"
      // L'arriere-plan grise n'est pas decoratif : il retire tout le reste de
      // l'ecran du champ d'action, au moment precis ou il ne faut rien faire
      // d'autre que copier ce message.
      bg="rgba(0, 0, 0, 0.55)"
      // `flex-start` + `overflowY` plutot que `center` : un conteneur flex
      // centre qui deborde rogne le HAUT de son enfant, et ce qu'on rognait
      // ici c'etait le titre puis l'avertissement disant que le code ne sera
      // plus jamais affiche. Sur un ecran de 844 px, cette popup en mesure 930.
      alignItems="flex-start"
      justifyContent="center"
      overflowY="auto"
      padding="4"
      zIndex="1000"
    >
      <Stack
        role="alertdialog"
        aria-modal="true"
        aria-label="Lien de depot cree"
        gap="5"
        bg="surface"
        borderRadius="lg"
        padding="6"
        maxWidth="34rem"
        width="100%"
        // Recentre verticalement quand la place le permet, et laisse defiler
        // sinon : `margin: auto` fait les deux la ou `align-items` doit choisir.
        marginY="auto"
      >
        <Stack gap="2">
          <Heading size="md">Demande creee</Heading>
          <Text>{deposit_request_title}</Text>
          <Text fontWeight="heading" color="danger.fg">
            Ce code ne vous sera plus jamais affiche : copiez le message maintenant.
          </Text>
        </Stack>

        <Box bg="accent.surface" borderRadius="md" padding="4" position="relative">
          <Flex justifyContent="flex-end" marginBottom="2">
            <CopyToClipboardButton
              text_to_copy={delivery.message}
              on_copied={(): void => set_has_been_copied(true)}
            />
          </Flex>
          <Text whiteSpace="pre-wrap">{delivery.message}</Text>
        </Box>

        <Text color="gray.default">
          Le lien expire le {format_date_and_time(delivery.expires_at)}.
        </Text>

        {is_warned_about_closing && !has_been_copied ? (
          <Text role="status" color="danger.fg">
            {UNCOPIED_WARNING}
          </Text>
        ) : null}

        <Flex justifyContent="flex-end">
          <PrimaryButton onClick={attempt_to_close}>
            {is_warned_about_closing && !has_been_copied ? 'Fermer quand meme' : 'Continuer'}
          </PrimaryButton>
        </Flex>
      </Stack>
    </Flex>
  );
}

// Le retour visuel est PORTE PAR LE BOUTON et survit quelques secondes au clic.
// Sans lui, rien ne distinguait un presse-papier rempli d'un presse-papier
// refuse : l'avocat recliquait, ou fermait une popup dont le contenu ne
// reviendra jamais.
function CopyToClipboardButton({
  text_to_copy,
  on_copied,
}: {
  readonly text_to_copy: string;
  readonly on_copied: () => void;
}): ReactElement {
  const recipe = useRecipe({ key: 'copyButton' });
  const [outcome, set_outcome] = useState<CopyOutcome>('untouched');
  const feedback_timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Le minuteur est annule au demontage : la popup se ferme souvent dans la
  // seconde qui suit la copie, et reveiller un composant demonte est une fuite
  // que React signale a juste titre.
  useEffect((): (() => void) => {
    return (): void => {
      if (feedback_timeout.current !== null) {
        clearTimeout(feedback_timeout.current);
      }
    };
  }, []);

  function show_outcome_for_a_few_seconds(next_outcome: CopyOutcome): void {
    if (feedback_timeout.current !== null) {
      clearTimeout(feedback_timeout.current);
    }

    set_outcome(next_outcome);
    feedback_timeout.current = setTimeout((): void => {
      set_outcome('untouched');
    }, COPY_FEEDBACK_DURATION_MS);
  }

  async function copy_the_message_to_the_clipboard(): Promise<void> {
    try {
      // `navigator.clipboard` est absent hors contexte securise, et `writeText`
      // rejette quand la permission est refusee. Les deux se traitent pareil :
      // on ne peut PAS annoncer une copie qui n'a pas eu lieu, l'avocat
      // fermerait la popup en croyant tenir le code.
      await navigator.clipboard.writeText(text_to_copy);
    } catch {
      show_outcome_for_a_few_seconds('failed');

      return;
    }

    show_outcome_for_a_few_seconds('copied');
    on_copied();
  }

  return (
    <Stack gap="2" alignItems="flex-end">
      <chakra.button
        type="button"
        css={recipe({ outcome })}
        onClick={(): void => void copy_the_message_to_the_clipboard()}
      >
        {COPY_BUTTON_LABELS[outcome]}
      </chakra.button>

      {outcome === 'failed' ? (
        <Text role="alert" color="danger.fg" textAlign="right">
          {COPY_FAILURE_MESSAGE}
        </Text>
      ) : null}
    </Stack>
  );
}
