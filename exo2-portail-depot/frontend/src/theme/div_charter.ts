// La charte DIV, telle que l'enonce la donne. C'est la SOURCE : le theme
// Chakra se construit a partir d'ici, et rien d'autre du depot n'a le droit
// d'ecrire une couleur.

export const DIV_BASE_COLORS = {
  primary: '#5100FF',
  secondary: '#916ED8',
  text: '#000000',
  gray: '#585858',
  gray_light: '#CECECE',
  border: '#E9E9E9',
  accent_surface: '#F7F6FF',
  accent_soft: '#DBCDFF',
} as const;

// Un couple texte / fond par semantique, jamais une couleur seule : un statut
// pose sur un fond cru serait illisible, et la charte demande explicitement des
// pastilles sur fond doux.
export const DIV_SEMANTIC_COLORS = {
  success: { fg: '#12AC64', bg: '#D9FFED' },
  danger: { fg: '#FF4C4C', bg: '#FFD0D0' },
  warning: { fg: '#DA9705', bg: '#FFEDCA' },
  info: { fg: '#52A0EE', bg: '#DBEDFF' },
} as const;

// Le blanc n'est pas dans la liste de l'enonce, et il est pourtant exige par
// deux regles ecrites : « cards : fond blanc » et « bouton primaire : texte
// blanc ». Il est donc nomme ici plutot que pose au vol dans un ecran.
export const DIV_SURFACE_COLOR = '#FFFFFF';

export const DIV_RADII = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  full: '999px',
} as const;

export const DIV_TYPOGRAPHY = {
  // Inter d'abord, puis la pile systeme : une police qui ne charge pas ne doit
  // pas rendre un empattement au milieu d'une interface qui n'en a aucun.
  family: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  body_weight: '400',
  heading_weight: '600',
} as const;

// Le reveal au scroll de la charte, en une seule definition : la duree et
// l'easing sont donnes par l'enonce et n'ont pas a etre recopies par ecran.
export const DIV_REVEAL_MOTION = {
  duration: '0.55s',
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  translate_from: '24px',
} as const;

// L'ensemble ferme des valeurs autorisees. C'est contre cette liste que le
// theme entier est balaye : tout ce qui n'y figure pas est une couleur hors DA.
export const DIV_CHARTER_HEX_VALUES: readonly string[] = [
  ...Object.values(DIV_BASE_COLORS),
  ...Object.values(DIV_SEMANTIC_COLORS).flatMap((semantic): string[] => [
    semantic.fg,
    semantic.bg,
  ]),
  DIV_SURFACE_COLOR,
].map((hex: string): string => hex.toUpperCase());
