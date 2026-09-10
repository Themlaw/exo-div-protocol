import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIV_BASE_COLORS,
  DIV_CHARTER_HEX_VALUES,
  DIV_RADII,
  DIV_SEMANTIC_COLORS,
  DIV_TYPOGRAPHY,
} from '../../src/theme/div_charter';
import { div_theme_config } from '../../src/theme/div_theme';

// Les valeurs de l'enonce, recopiees ICI et nulle part ailleurs. Ce fichier est
// le seul endroit du depot ou elles apparaissent en double : si la charte et le
// theme divergent, c'est ce test qui le dit, pas une capture d'ecran.
const CHARTER_BASE = {
  primary: '#5100FF',
  secondary: '#916ED8',
  text: '#000000',
  gray: '#585858',
  gray_light: '#CECECE',
  border: '#E9E9E9',
  accent_surface: '#F7F6FF',
  accent_soft: '#DBCDFF',
};

const CHARTER_SEMANTIC = {
  success: { fg: '#12AC64', bg: '#D9FFED' },
  danger: { fg: '#FF4C4C', bg: '#FFD0D0' },
  warning: { fg: '#DA9705', bg: '#FFEDCA' },
  info: { fg: '#52A0EE', bg: '#DBEDFF' },
};

function collect_hex_values(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    const matches: RegExpMatchArray | null = value.match(/#[0-9a-fA-F]{3,8}/g);
    if (matches !== null) {
      found.push(...matches);
    }
    return found;
  }

  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collect_hex_values(nested, found);
    }
  }

  return found;
}

function list_source_files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry: string): string[] => {
    const path: string = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return list_source_files(path);
    }
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

describe('Charte graphique DIV', () => {
  it('porte exactement les huit couleurs de base de la charte', () => {
    expect(DIV_BASE_COLORS).toEqual(CHARTER_BASE);
  });

  it('porte les quatre semantiques avec leur couple texte et fond', () => {
    expect(DIV_SEMANTIC_COLORS).toEqual(CHARTER_SEMANTIC);
  });

  it('porte les quatre radius, dont le radius plein des boutons et des pills', () => {
    expect(DIV_RADII).toEqual({ sm: '4px', md: '8px', lg: '12px', full: '999px' });
  });

  it('porte Inter, en 400 pour le corps et 600 pour les titres et les CTA', () => {
    expect(DIV_TYPOGRAPHY.family).toContain('Inter');
    expect(DIV_TYPOGRAPHY.body_weight).toBe('400');
    expect(DIV_TYPOGRAPHY.heading_weight).toBe('600');
  });

  // « Aucune couleur hors de la DA » cesse d'etre une intention : le theme est
  // balaye entier, et toute valeur hexadecimale qui n'est pas a la charte fait
  // echouer la suite.
  it("n'introduit aucune couleur etrangere a la charte dans le theme", () => {
    const declared: readonly string[] = collect_hex_values(div_theme_config);

    const foreign: readonly string[] = declared.filter(
      (hex: string): boolean => !DIV_CHARTER_HEX_VALUES.includes(hex.toUpperCase()),
    );

    expect(foreign).toEqual([]);
  });

  // Le theme ne protege que ce qui passe par lui. Un `bg="#ff0000"` ou un
  // `color="red.500"` pose au vol dans un ecran contournerait tout : Chakra
  // sert sa propre palette par defaut, et elle repondrait. Le seul controle
  // possible est donc lexical, et il porte sur le code source.
  it('ne laisse aucune couleur crue ni palette Chakra hors du dossier du theme', () => {
    const offenders: string[] = [];

    for (const path of list_source_files('src')) {
      if (path.startsWith(join('src', 'theme'))) {
        continue;
      }

      const source: string = readFileSync(path, 'utf8');
      const raw_hex: RegExpMatchArray | null = source.match(/#[0-9a-fA-F]{3,8}\b/g);
      const chakra_palette: RegExpMatchArray | null = source.match(
        /\b(?:gray|red|orange|yellow|green|teal|blue|cyan|purple|pink)\.\d{2,3}\b/g,
      );

      if (raw_hex !== null || chakra_palette !== null) {
        offenders.push(`${path}: ${[...(raw_hex ?? []), ...(chakra_palette ?? [])].join(', ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
