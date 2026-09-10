import type { ReactElement } from 'react';
import { Heading, Stack, Text } from '@chakra-ui/react';

// Un ecran declare mais pas encore ecrit. Il existe pour que la table des
// routes soit COMPLETE des le socle : c'est elle que le test de protection par
// defaut parcourt, et une route ajoutee plus tard, en meme temps que son ecran,
// est une route qu'on peut oublier de garder.
export interface ScreenUnderConstructionProps {
  readonly screen_name: string;
}

export function ScreenUnderConstruction({
  screen_name,
}: ScreenUnderConstructionProps): ReactElement {
  return (
    <Stack gap="3" paddingY="10">
      <Heading size="md">{screen_name}</Heading>
      <Text>Cet ecran arrive au bloc suivant.</Text>
    </Stack>
  );
}
