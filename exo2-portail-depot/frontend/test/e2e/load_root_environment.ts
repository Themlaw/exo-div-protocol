import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT_ENVIRONMENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.env',
);

const SURROUNDING_QUOTES = /^(?<quote>["'])(?<inner>.*)\k<quote>$/;

// Le fichier genere met TOUTES ses valeurs entre guillemets, parce que la phrase
// de passe de demonstration contient des espaces. Le shell les retire en lisant
// `. .env`, donc l'application recoit la valeur nue — ce lecteur doit faire
// pareil, sans quoi le formulaire de connexion se remplirait avec les guillemets
// et le portail refuserait, a juste titre.
//
// Seule une PAIRE qui encadre toute la valeur est retiree : un guillemet
// interieur fait partie de la valeur, et l'amputer serait pire que de le garder.
export function parse_environment_declarations(contents: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();

  for (const line of contents.split('\n')) {
    const declaration: string = line.trim();

    if (declaration === '' || declaration.startsWith('#')) {
      continue;
    }

    const separator_index: number = declaration.indexOf('=');

    if (separator_index <= 0) {
      continue;
    }

    const name: string = declaration.slice(0, separator_index).trim();
    const written_value: string = declaration.slice(separator_index + 1).trim();
    const unquoted: string | undefined = SURROUNDING_QUOTES.exec(written_value)?.groups?.['inner'];

    // `??` et non `||` : une valeur vide entre guillemets EST une valeur vide.
    declarations.set(name, unquoted ?? written_value);
  }

  return declarations;
}

// Une vingtaine de lignes plutot qu'une dependance de plus : on ne lit ici qu'un
// fichier `clef=valeur` qu'on ecrit nous-memes.
//
// Le processus Playwright a besoin des MEMES valeurs que l'application : le
// compte de demonstration est amorce a partir d'elles, et `install.sh` les tire
// au sort — les recopier dans un fichier de test les ferait diverger des la
// premiere installation.
export default function load_root_environment(): void {
  for (const [name, value] of parse_environment_declarations(
    readFileSync(ROOT_ENVIRONMENT_FILE, 'utf8'),
  )) {
    // Ce qui vient de l'appelant l'emporte : c'est ce qui permet de viser une
    // autre pile sans reecrire le fichier.
    process.env[name] ??= value;
  }
}
