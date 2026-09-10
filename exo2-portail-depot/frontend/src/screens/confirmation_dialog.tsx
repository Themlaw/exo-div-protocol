import type { ReactElement } from 'react';
import { Flex, Heading, Stack, Text } from '@chakra-ui/react';

import { PrimaryButton, SecondaryButton } from '../ui/div_button';

export interface ConfirmationDialogProps {
  readonly title: string;
  readonly consequence: string;
  readonly confirm_label: string;
  readonly on_confirm: () => void;
  readonly on_cancel: () => void;
}

// La phrase demandee n'est pas « etes-vous sur ? » mais la CONSEQUENCE : c'est
// elle qui permet de decider, et elle seule.
export function ConfirmationDialog({
  title,
  consequence,
  confirm_label,
  on_confirm,
  on_cancel,
}: ConfirmationDialogProps): ReactElement {
  return (
    <Flex
      position="fixed"
      inset="0"
      bg="rgba(0, 0, 0, 0.55)"
      alignItems="center"
      justifyContent="center"
      padding="4"
      zIndex="1000"
    >
      <Stack
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        gap="5"
        bg="surface"
        borderRadius="lg"
        padding="6"
        maxWidth="30rem"
        width="100%"
      >
        <Heading size="md">{title}</Heading>
        <Text>{consequence}</Text>
        <Flex justifyContent="flex-end" gap="3">
          <SecondaryButton onClick={on_cancel}>Annuler</SecondaryButton>
          <PrimaryButton onClick={on_confirm}>{confirm_label}</PrimaryButton>
        </Flex>
      </Stack>
    </Flex>
  );
}
