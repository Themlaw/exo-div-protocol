import type { ReactElement } from 'react';
import { chakra, useRecipe, type HTMLChakraProps } from '@chakra-ui/react';
import { Link, type LinkProps } from 'react-router-dom';

const ChakraRouterLink = chakra(Link);

export function DivCard(props: HTMLChakraProps<'div'>): ReactElement {
  const recipe = useRecipe({ key: 'card' });

  return <chakra.div css={recipe()} {...props} />;
}

// Une carte cliquable est un LIEN et non une div avec un `onClick` : c'est ce
// qui donne le clic milieu, le « ouvrir dans un onglet » et la navigation au
// clavier sans avoir a les reecrire.
export function DivCardLink(props: LinkProps & HTMLChakraProps<'a'>): ReactElement {
  const recipe = useRecipe({ key: 'card' });

  return <ChakraRouterLink css={recipe()} display="block" {...props} />;
}
