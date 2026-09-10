import type { ReactElement } from 'react';
import { chakra, useRecipe, type HTMLChakraProps } from '@chakra-ui/react';

// Les recettes du theme sont montees ICI, une fois, plutot que rappelees par
// chaque ecran : c'est ce qui garantit qu'un bouton primaire est le meme
// partout, et que l'inversion au survol dessinee par la charte ne peut pas etre
// oubliee sur un ecran.
export type DivButtonProps = HTMLChakraProps<'button'>;

export function PrimaryButton(props: DivButtonProps): ReactElement {
  const recipe = useRecipe({ key: 'primaryButton' });

  return <chakra.button type="button" css={recipe()} {...props} />;
}

export function SecondaryButton(props: DivButtonProps): ReactElement {
  const recipe = useRecipe({ key: 'secondaryButton' });

  return <chakra.button type="button" css={recipe()} {...props} />;
}
