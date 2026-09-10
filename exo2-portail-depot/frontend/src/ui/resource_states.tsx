import type { ReactElement, ReactNode } from 'react';
import { Stack, Text } from '@chakra-ui/react';

import { SecondaryButton } from './div_button';

// Les quatre etats sont nommes plutot que deduits d'un booleen `is_loading` :
// « rien a afficher » et « je n'ai pas pu charger » ne se disent pas de la meme
// facon, et les confondre fait chercher une panne a qui n'a simplement encore
// rien cree.
export type ResourceState = 'loading' | 'error' | 'empty' | 'ready';

export interface ResourceStatesProps {
  readonly state: ResourceState;
  readonly loading_label: string;
  readonly error_message: string;
  readonly on_retry: () => void;
  readonly empty_message: string;
  readonly empty_call_to_action: ReactNode;
  readonly children: ReactNode;
}

export function ResourceStates({
  state,
  loading_label,
  error_message,
  on_retry,
  empty_message,
  empty_call_to_action,
  children,
}: ResourceStatesProps): ReactElement {
  if (state === 'loading') {
    // `role="status"` : un lecteur d'ecran n'a aucun autre moyen d'apprendre
    // que l'ecran travaille encore.
    return (
      <Stack role="status" aria-live="polite" gap="3" paddingY="8">
        <Text>{loading_label}</Text>
      </Stack>
    );
  }

  if (state === 'error') {
    return (
      <Stack role="alert" gap="4" paddingY="8" alignItems="flex-start">
        <Text>{error_message}</Text>
        <SecondaryButton onClick={on_retry}>Reessayer</SecondaryButton>
      </Stack>
    );
  }

  if (state === 'empty') {
    // Un ecran vide sans issue se lit comme une panne : le vide porte donc
    // toujours l'action qui le fait cesser.
    return (
      <Stack gap="4" paddingY="8" alignItems="flex-start">
        <Text>{empty_message}</Text>
        {empty_call_to_action}
      </Stack>
    );
  }

  return <>{children}</>;
}
