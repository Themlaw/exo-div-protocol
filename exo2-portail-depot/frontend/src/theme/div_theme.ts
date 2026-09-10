import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';
import {
  DIV_BASE_COLORS,
  DIV_RADII,
  DIV_REVEAL_MOTION,
  DIV_SEMANTIC_COLORS,
  DIV_SURFACE_COLOR,
  DIV_TYPOGRAPHY,
} from './div_charter';
import { DIV_RECIPES } from './div_recipes';

// Le theme UNIQUE. Il porte tout ce qui est global — couleurs, typo, radius,
// recettes — et il se construit a partir de `div_charter.ts` : aucune valeur
// n'est recopiee ici, sinon la charte et le theme finiraient par diverger sans
// que rien ne le signale.
export const div_theme_config = defineConfig({
  // Site LIGHT ONLY : la charte l'ecrit noir sur blanc. Sans cette condition
  // figee, Chakra suivrait la preference systeme et rendrait un theme sombre
  // que personne n'a dessine.
  globalCss: {
    'html, body': {
      bg: 'surface',
      color: 'text',
      fontFamily: 'body',
      fontWeight: 'body',
      colorScheme: 'light',
    },
    '*::selection': {
      bg: 'accent.soft',
    },
  },
  theme: {
    tokens: {
      colors: {
        primary: { value: DIV_BASE_COLORS.primary },
        secondary: { value: DIV_BASE_COLORS.secondary },
        text: { value: DIV_BASE_COLORS.text },
        surface: { value: DIV_SURFACE_COLOR },
        border: { value: DIV_BASE_COLORS.border },
        gray: {
          default: { value: DIV_BASE_COLORS.gray },
          light: { value: DIV_BASE_COLORS.gray_light },
        },
        accent: {
          surface: { value: DIV_BASE_COLORS.accent_surface },
          soft: { value: DIV_BASE_COLORS.accent_soft },
        },
        success: {
          fg: { value: DIV_SEMANTIC_COLORS.success.fg },
          bg: { value: DIV_SEMANTIC_COLORS.success.bg },
        },
        danger: {
          fg: { value: DIV_SEMANTIC_COLORS.danger.fg },
          bg: { value: DIV_SEMANTIC_COLORS.danger.bg },
        },
        warning: {
          fg: { value: DIV_SEMANTIC_COLORS.warning.fg },
          bg: { value: DIV_SEMANTIC_COLORS.warning.bg },
        },
        info: {
          fg: { value: DIV_SEMANTIC_COLORS.info.fg },
          bg: { value: DIV_SEMANTIC_COLORS.info.bg },
        },
      },
      fonts: {
        body: { value: DIV_TYPOGRAPHY.family },
        heading: { value: DIV_TYPOGRAPHY.family },
      },
      fontWeights: {
        body: { value: DIV_TYPOGRAPHY.body_weight },
        heading: { value: DIV_TYPOGRAPHY.heading_weight },
      },
      radii: {
        sm: { value: DIV_RADII.sm },
        md: { value: DIV_RADII.md },
        lg: { value: DIV_RADII.lg },
        full: { value: DIV_RADII.full },
      },
      durations: {
        reveal: { value: DIV_REVEAL_MOTION.duration },
      },
      easings: {
        reveal: { value: DIV_REVEAL_MOTION.easing },
      },
    },
    recipes: DIV_RECIPES,
    keyframes: {
      // Le reveal au scroll de la charte : opacite 0 -> 1 et y 24 -> 0.
      reveal: {
        from: { opacity: '0', transform: `translateY(${DIV_REVEAL_MOTION.translate_from})` },
        to: { opacity: '1', transform: 'translateY(0)' },
      },
    },
  },
});

export const div_system = createSystem(defaultConfig, div_theme_config);
