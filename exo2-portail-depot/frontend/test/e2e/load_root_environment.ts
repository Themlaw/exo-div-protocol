import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT_ENVIRONMENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.env',
);

// Une douzaine de lignes plutot qu'une dependance de plus : on ne lit ici qu'un
// fichier `clef=valeur` qu'on ecrit nous-memes, et `dotenv` apporterait
// l'interpolation, les guillemets et les surprises qui vont avec.
//
// Le processus Playwright a besoin des MEMES valeurs que l'application : le
// compte de demonstration est amorce a partir d'elles, et `install.sh` les tire
// au sort — les recopier dans un fichier de test les ferait diverger des la
// premiere installation.
export default function load_root_environment(): void {
  for (const line of readFileSync(ROOT_ENVIRONMENT_FILE, 'utf8').split('\n')) {
    const declaration: string = line.trim();

    if (declaration === '' || declaration.startsWith('#')) {
      continue;
    }

    const separator_index: number = declaration.indexOf('=');

    if (separator_index <= 0) {
      continue;
    }

    const name: string = declaration.slice(0, separator_index).trim();

    // Ce qui vient de l'appelant l'emporte : c'est ce qui permet de viser une
    // autre pile sans reecrire le fichier.
    process.env[name] ??= declaration.slice(separator_index + 1).trim();
  }
}
