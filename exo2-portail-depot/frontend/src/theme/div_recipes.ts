import { defineRecipe } from '@chakra-ui/react';
import { DIV_BASE_COLORS } from './div_charter';

// Tout ce qui est REUTILISABLE vit ici. Les props de style Chakra, dans les
// ecrans, ne servent qu'au local : une marge, un gap, un ajustement d'un seul
// endroit. Une regle qui se repete sur deux ecrans a sa place dans une recette.

// Le contour du survol est pose en `boxShadow: inset` plutot qu'en `border` :
// une bordure qui apparait au survol decalerait le contenu d'un pixel, et le
// bouton bougerait sous le curseur.
// Le survol est reserve aux pointeurs qui survolent VRAIMENT. Sur tactile, un
// `:hover` reste accroche apres le tap : le bouton primaire gardait son style
// inverse et devenait indiscernable d'un bouton secondaire, sur l'ecran meme ou
// l'on venait d'appuyer.
const HOVER_CAPABLE_POINTER = '@media (hover: hover)';

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
    [HOVER_CAPABLE_POINTER]: {
      _hover: {
        bg: 'accent.surface',
        color: 'primary',
        boxShadow: PRIMARY_INSET_OUTLINE,
      },
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
    [HOVER_CAPABLE_POINTER]: { _hover: { bg: 'accent.surface' } },
    _focusVisible: {
      outline: '2px solid',
      outlineColor: 'primary',
      outlineOffset: '2px',
    },
    // Le contour est CONSERVE, seulement attenue : le retirer ne laissait qu'un
    // mot gris flottant en bout de ligne, qui ne se lisait plus comme un bouton
    // mais comme une etiquette.
    _disabled: {
      bg: 'surface',
      color: 'gray.default',
      boxShadow: `inset 0 0 0 1px ${DIV_BASE_COLORS.gray_light}`,
      cursor: 'not-allowed',
    },
  },
});

// Le declencheur de selection de fichier. Il existe parce que le controle natif
// ne se laisse ni traduire ni contraindre : il s'annonce « Choose File / No file
// chosen » en anglais au milieu d'une application francaise, il impose sa propre
// largeur — 344 px, seule cause du defilement lateral du tableau de depot sous
// 390 px — et il se dessine 30 px de haut, tres en dessous d'une cible tactile.
// L'input reste dans le DOM, masque : c'est LUI qui porte le nom accessible et
// qui ouvre le selecteur, ce label ne fait que l'habiller.
export const file_chooser_recipe = defineRecipe({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    width: '100%',
    // Le seul reglage qui compte pour le mobile : le declencheur suit la largeur
    // de sa carte au lieu de la dicter.
    maxWidth: '100%',
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
    textAlign: 'center',
    transition: 'background-color 0.18s ease',
    [HOVER_CAPABLE_POINTER]: { _hover: { bg: 'accent.surface' } },
    // Le focus du LABEL ne se voit pas : c'est l'input masque qui le recoit.
    '&:has(input:focus-visible)': {
      outline: '2px solid',
      outlineColor: 'primary',
      outlineOffset: '2px',
    },
    // Un label ne connait pas `:disabled` : l'etat vient de l'input qu'il
    // contient, seul a le porter reellement.
    '&:has(input:disabled)': {
      color: 'gray.default',
      boxShadow: `inset 0 0 0 1px ${DIV_BASE_COLORS.gray_light}`,
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

// Le bouton de copie de la popup de delivrance. Il n'est pas un bouton
// secondaire de plus : c'est le SEUL geste qui sauve un code que le serveur ne
// sait plus redire, et son resultat doit donc rester lisible plusieurs secondes
// apres le clic. L'etat vit dans une variante du theme parce qu'un vert ecrit a
// la main dans un ecran serait une couleur hors DA.
export const copy_button_recipe = defineRecipe({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontWeight: 'heading',
    fontSize: 'md',
    lineHeight: '1.2',
    paddingInline: '24px',
    paddingBlock: '14px',
    borderRadius: 'full',
    cursor: 'pointer',
    transition: 'background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease',
    _focusVisible: {
      outline: '2px solid',
      outlineColor: 'primary',
      outlineOffset: '2px',
    },
  },
  variants: {
    outcome: {
      untouched: {
        bg: 'surface',
        color: 'primary',
        boxShadow: PRIMARY_INSET_OUTLINE,
        [HOVER_CAPABLE_POINTER]: { _hover: { bg: 'accent.surface' } },
        // Le seul endroit du theme ou l'enfoncement est dessine : sur ce
        // bouton, l'avocat doit voir que son clic a ete pris, meme s'il relache
        // avant que le presse-papier ait repondu.
        _active: { bg: 'accent.soft' },
      },
      copied: {
        bg: 'success.bg',
        color: 'success.fg',
        boxShadow: 'none',
        // Pas de survol qui rende le vert : l'etat tient QUELQUES SECONDES et
        // le curseur est encore dessus. Le laisser reagir au hover ferait
        // clignoter la confirmation que l'on vient d'afficher.
        _hover: { bg: 'success.bg' },
      },
      failed: {
        bg: 'danger.bg',
        color: 'danger.fg',
        boxShadow: 'none',
        _hover: { bg: 'danger.bg' },
      },
    },
  },
  defaultVariants: { outcome: 'untouched' },
});

// Le retour d'un ecran de detail vers sa liste. Sobre par decision : c'est un
// fil d'ariane, pas une barre de navigation — il ne doit jamais concurrencer du
// regard le titre du dossier qu'il surmonte.
export const back_link_recipe = defineRecipe({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    color: 'gray.default',
    fontSize: 'sm',
    fontWeight: 'heading',
    textDecoration: 'none',
    transition: 'color 0.18s ease',
    [HOVER_CAPABLE_POINTER]: {
      _hover: { color: 'primary', textDecoration: 'underline' },
    },
    _focusVisible: {
      outline: '2px solid',
      outlineColor: 'primary',
      outlineOffset: '2px',
      borderRadius: 'sm',
    },
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
  fileChooser: file_chooser_recipe,
  copyButton: copy_button_recipe,
  backLink: back_link_recipe,
  textField: text_field_recipe,
  dropZone: drop_zone_recipe,
  generatedLink: generated_link_recipe,
} as const;
