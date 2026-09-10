import { describe, expect, it } from 'vitest';

import { parse_environment_declarations } from '../e2e/load_root_environment';

describe('Lecture du .env par les tests de bout en bout', () => {
  // Le shell retire les guillemets en lisant `. .env`, si bien que
  // l'application recoit `avocat@demo.local` la ou ce lecteur recevait
  // `"avocat@demo.local"`. Le formulaire de connexion se remplissait alors avec
  // des guillemets, et le portail repondait — a juste titre — identifiants
  // invalides.
  it('retire les guillemets doubles qui entourent une valeur', () => {
    expect(parse_environment_declarations('DEMO_LAWYER_EMAIL="avocat@demo.local"')).toEqual(
      new Map([['DEMO_LAWYER_EMAIL', 'avocat@demo.local']]),
    );
  });

  it('retire les apostrophes qui entourent une valeur', () => {
    expect(parse_environment_declarations("POSTGRES_USER='portail'")).toEqual(
      new Map([['POSTGRES_USER', 'portail']]),
    );
  });

  // La raison d'etre des guillemets dans le fichier genere : la phrase de passe
  // de demonstration contient des espaces.
  it('conserve une valeur a espaces entiere', () => {
    expect(
      parse_environment_declarations('DEMO_LAWYER_PASSWORD="action chemin bruit chalet affiche"'),
    ).toEqual(new Map([['DEMO_LAWYER_PASSWORD', 'action chemin bruit chalet affiche']]));
  });

  it('rend une chaine vide pour une valeur vide entre guillemets', () => {
    expect(parse_environment_declarations('ACME_CA_SERVER=""')).toEqual(
      new Map([['ACME_CA_SERVER', '']]),
    );
  });

  it('laisse intacte une valeur sans guillemets', () => {
    expect(parse_environment_declarations('POSTGRES_PORT=22310')).toEqual(
      new Map([['POSTGRES_PORT', '22310']]),
    );
  });

  // Un guillemet qui n'entoure rien n'est pas un guillemet d'encadrement : le
  // retirer amputerait la valeur.
  it('ne touche pas a un guillemet interieur', () => {
    expect(parse_environment_declarations('MESSAGE=il a dit "non"')).toEqual(
      new Map([['MESSAGE', 'il a dit "non"']]),
    );
  });

  it("ne retire pas un guillemet ouvrant sans fermant", () => {
    expect(parse_environment_declarations('MESSAGE="inachevee')).toEqual(
      new Map([['MESSAGE', '"inachevee']]),
    );
  });

  // Une paire DEPAREILLEE n'encadre rien : le shell ne la retirerait pas non plus.
  it('ne retire pas une paire de guillemets depareillee', () => {
    expect(parse_environment_declarations('MESSAGE="mixte\'')).toEqual(
      new Map([['MESSAGE', '"mixte\'']]),
    );
  });

  // Les URL de connexion en contiennent : couper au dernier `=` les tronquerait.
  it('ne coupe qu au premier signe egal', () => {
    expect(parse_environment_declarations('DATABASE_URL="postgres://u:p@h/d?a=b"')).toEqual(
      new Map([['DATABASE_URL', 'postgres://u:p@h/d?a=b']]),
    );
  });

  // Le commentaire porte lui-meme un `=` : c'est la forme qu'ont les valeurs
  // mises de cote dans .env.example, et celle qui distingue vraiment le test du
  // commentaire de la simple absence de separateur.
  it('ignore les commentaires et les lignes vides', () => {
    expect(
      parse_environment_declarations('# ACME_CA_SERVER=https://exemple\n\nA="1"\n   \n# autre'),
    ).toEqual(new Map([['A', '1']]));
  });

  it('ignore une ligne sans nom', () => {
    expect(parse_environment_declarations('=orpheline\nA="1"')).toEqual(new Map([['A', '1']]));
  });
});
