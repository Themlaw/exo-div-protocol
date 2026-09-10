import { useState, type ReactElement } from 'react';
import { Box, Flex, Heading, Stack, Text } from '@chakra-ui/react';

import type { AccessLinkDelivery } from '../api/contracts';
import { PrimaryButton, SecondaryButton } from '../ui/div_button';
import { format_date_and_time } from '../ui/format';

const UNCOPIED_WARNING =
  'Vous n avez pas copie le message. Fermer maintenant le perdra definitivement.';

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

  async function copy_the_message(): Promise<void> {
    await navigator.clipboard.writeText(delivery.message);
    set_has_been_copied(true);
  }

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
      alignItems="center"
      justifyContent="center"
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
            <SecondaryButton onClick={() => void copy_the_message()}>
              Copier le message
            </SecondaryButton>
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
