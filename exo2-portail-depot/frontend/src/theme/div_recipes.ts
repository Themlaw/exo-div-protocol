import { defineRecipe } from '@chakra-ui/react';
import { DIV_BASE_COLORS } from './div_charter';

// Tout ce qui est REUTILISABLE vit ici. Les props de style Chakra, dans les
// ecrans, ne servent qu'au local : une marge, un gap, un ajustement d'un seul
// endroit. Une regle qui se repete sur deux ecrans a sa place dans une recette.

// Le contour du survol est pose en `boxShadow: inset` plutot qu'en `border` :
// une bordure qui apparait au survol decalerait le contenu d'un pixel, et le
// bouton bougerait sous le curseur.
const PRIMARY_INSET_OUTLINE = `inset 0 0 0 1px ${DIV_BASE_COLORS.primary}`;

export const primary_button_recipe = defineRecipe({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    bg: 'primary',
    color: 'surface',
    fontWeight: 'heading',
    fontSize: 'md',
    lineHeight: '1.2',
    paddingInline: '24px',
    paddingBlock: '14px',
    borderRadius: 'full',
    cursor: 'pointer',
    // La transition porte sur les trois proprietes qui changent, jamais sur
    // `all` : `all` animerait aussi la geometrie et rendrait le bouton mou.
    transition: 'background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease',
    _hover: {
      bg: 'accent.surface',
      color: 'primary',
      boxShadow: PRIMARY_INSET_OUTLINE,
    },
    _focusVisible: {
      outline: '2px solid',
      outlineColor: 'primary',
      outlineOffset: '2px',
    },
    _disabled: {
      bg: 'gray.light',
      color: 'gray.default',
      cursor: 'not-allowed',
      boxShadow: 'none',
    },
  },
});

// Le secondaire porte deja le contour au repos : c'est ce qui le distingue du
// primaire, et il n'a donc rien a inverser au survol.
export const secondary_button_recipe = defineRecipe({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    bg: 'surface',
    color: 'primary',
    fontWeight: 'heading',
    fontSize: 'md',
    lineHeight: '1.2',
    paddingInline: '24px',
    paddingBlock: '14px',
    borderRadius: 'full',
    boxShadow: PRIMARY_INSET_OUTLINE,
    cursor: 'pointer',
    transition: 'background-color 0.18s ease',
    _hover: { bg: 'accent.surface' },
    _focusVisible: {
      outline: '2px solid',
      outlineColor: 'primary',
      outlineOffset: '2px',
    },
    _disabled: {
      bg: 'surface',
      color: 'gray.default',
      boxShadow: 'none',
      cursor: 'not-allowed',
    },
  },
});

// « Cards : fond blanc, bordure 1px, radius 12px, SANS ombre. » L'absence
// d'ombre est une regle de la charte, pas un oubli.
export const card_recipe = defineRecipe({
  base: {
    bg: 'surface',
    borderWidth: '1px',
    borderColor: 'border',
    borderRadius: 'lg',
    boxShadow: 'none',
    padding: '20px',
  },
});

// Une pastille de statut porte TOUJOURS son couple texte / fond semantique.
// La variante est la seule facon d'en obtenir une : ecrire une couleur a la
// main sur une pill est ce que le test lexical du theme interdit.
export const status_pill_recipe = defineRecipe({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    paddingInline: '12px',
    paddingBlock: '4px',
    borderRadius: 'full',
    fontSize: 'sm',
    fontWeight: 'heading',
    whiteSpace: 'nowrap',
  },
  variants: {
    tone: {
      neutral: { bg: 'accent.surface', color: 'gray.default' },
      success: { bg: 'success.bg', color: 'success.fg' },
      danger: { bg: 'danger.bg', color: 'danger.fg' },
      warning: { bg: 'warning.bg', color: 'warning.fg' },
      info: { bg: 'info.bg', color: 'info.fg' },
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export const text_field_recipe = defineRecipe({
  base: {
    width: '100%',
    bg: 'surface',
    color: 'text',
    borderWidth: '1px',
    borderColor: 'border',
    borderRadius: 'md',
    paddingInline: '12px',
    paddingBlock: '10px',
    fontSize: 'md',
    _placeholder: { color: 'gray.light' },
    _focusVisible: {
      outline: 'none',
      borderColor: 'primary',
      boxShadow: `inset 0 0 0 1px ${DIV_BASE_COLORS.primary}`,
    },
    _disabled: { bg: 'accent.surface', cursor: 'not-allowed' },
    _invalid: { borderColor: 'danger.fg' },
  },
});

// « Zone de depot : bordure pointillee, fond accent au survol. »
export const drop_zone_recipe = defineRecipe({
  base: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    width: '100%',
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: 'gray.light',
    borderRadius: 'lg',
    padding: '24px',
    textAlign: 'center',
    cursor: 'pointer',
    transition: 'background-color 0.18s ease, border-color 0.18s ease',
    _hover: { bg: 'accent.surface', borderColor: 'primary' },
  },
});

// « Lien genere : monospace, tronque, action Copier a droite. »
export const generated_link_recipe = defineRecipe({
  base: {
    fontFamily: 'mono',
    fontSize: 'sm',
    color: 'gray.default',
    bg: 'accent.surface',
    borderRadius: 'md',
    paddingInline: '12px',
    paddingBlock: '8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: '0',
  },
});

export const DIV_RECIPES = {
  primaryButton: primary_button_recipe,
  secondaryButton: secondary_button_recipe,
  card: card_recipe,
  statusPill: status_pill_recipe,
  textField: text_field_recipe,
  dropZone: drop_zone_recipe,
  generatedLink: generated_link_recipe,
} as const;
