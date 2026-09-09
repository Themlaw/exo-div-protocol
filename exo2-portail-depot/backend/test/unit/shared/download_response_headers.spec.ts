import {
  build_download_response_headers,
  build_presigned_download_response_overrides,
} from '../../../src/shared/download_response_headers';

describe('build_download_response_headers', () => {
  it(
    "le fichier est servi en piece jointe : sans cela un document depose s'ouvrirait DANS " +
      'notre origine, ce qui est le XSS stocke que craint un portail de depot',
    () => {
      const headers = build_download_response_headers('contrat.pdf');

      expect(headers['content-disposition']).toContain('attachment');
      expect(headers['content-disposition']).toContain('filename="contrat.pdf"');
    },
  );

  it("rien n'est conserve : une piece juridique ne doit pas rester sur le disque apres la deconnexion", () => {
    expect(build_download_response_headers('contrat.pdf')['cache-control']).toBe(
      'no-store, no-cache, must-revalidate, private',
    );
  });

  it('aucun autre site ne peut charger la piece en sous-ressource', () => {
    expect(build_download_response_headers('contrat.pdf')['cross-origin-resource-policy']).toBe(
      'same-origin',
    );
  });

  it(
    'un nom accentue est transmis en forme encodee, et la forme simple reste lisible : le nom ' +
      "vient du client, il n'a aucune raison d'etre en ASCII",
    () => {
      const headers = build_download_response_headers('piece jointe e.pdf');

      expect(headers['content-disposition']).toContain(
        "filename*=UTF-8''piece%20jointe%20e.pdf",
      );
    },
  );

  it(
    "un nom porteur de guillemets ou de retours a la ligne ne peut pas fabriquer d'en-tetes : " +
      "le nom de fichier est choisi par celui qui depose, donc potentiellement par l'attaquant",
    () => {
      const headers = build_download_response_headers(
        'innocent".pdf\r\nSet-Cookie: session=vole\r\n\r\n',
      );

      // Ce qui compte est qu'aucun en-tete ne puisse etre FABRIQUE : plus de
      // retour a la ligne, et plus de guillemet pour sortir de la valeur. Le
      // texte « Set-Cookie » qui subsiste reste inerte a l'interieur des
      // guillemets — le masquer donnerait l'illusion d'une liste noire, alors
      // que la garantie vient du retrait des caracteres de controle.
      expect(headers['content-disposition']).not.toMatch(/[\r\n]/);
      expect(headers['content-disposition']).not.toContain('".pdf');
      expect(headers['content-disposition'].split('"').length - 1).toBe(2);
    },
  );

  it("un chemin dans le nom est reduit a son dernier segment : on ne propose pas un chemin d'arborescence", () => {
    const headers = build_download_response_headers('../../etc/passwd');

    expect(headers['content-disposition']).toContain('filename="passwd"');
    expect(headers['content-disposition']).not.toContain('..');
  });

  it('un nom vide ou reduit a rien retombe sur un nom neutre plutot que sur un en-tete casse', () => {
    expect(build_download_response_headers('   ')['content-disposition']).toContain(
      'filename="document"',
    );
  });
});

// Mesure sur le MinIO du projet : les octets d'un telechargement presigne ne
// passent JAMAIS par notre application, donc aucun en-tete pose par elle ne les
// accompagne. Un GET presigne nu rend `content-type: text/html` pour un objet
// depose en HTML, sans disposition ni cache-control — le document s'ouvre donc
// dans le navigateur, a l'origine du stockage.
//
// Verifie aussi : MinIO honore les parametres `response-*` quand ils sont
// SIGNES, et repond 403 si on les modifie apres signature. Le client ne peut
// donc pas retourner `attachment` en `inline`.
describe('build_presigned_download_response_overrides', () => {
  it('les trois consignes voyagent en parametres signes, pas en en-tetes', () => {
    const overrides = build_presigned_download_response_overrides('contrat.pdf');

    expect(overrides['response-content-disposition']).toContain('attachment');
    expect(overrides['response-cache-control']).toBe('no-store, no-cache, must-revalidate, private');
    expect(overrides['response-content-type']).toBe('application/octet-stream');
  });

  it(
    'le type est force a un flux binaire : sans cela un fichier depose en text/html est rendu ' +
      "comme une page par le navigateur, a l'origine du stockage",
    () => {
      expect(
        build_presigned_download_response_overrides('page.html')['response-content-type'],
      ).toBe('application/octet-stream');
    },
  );

  it('le nom de fichier subit le meme nettoyage que pour une reponse servie par nous', () => {
    const overrides = build_presigned_download_response_overrides('../../etc/passwd');

    expect(overrides['response-content-disposition']).toContain('filename="passwd"');
    expect(overrides['response-content-disposition']).not.toMatch(/[\r\n]/);
  });

  it('la disposition est identique a celle de la voie servie par nous : une seule source', () => {
    expect(build_presigned_download_response_overrides('contrat.pdf')['response-content-disposition'])
      .toBe(build_download_response_headers('contrat.pdf')['content-disposition']);
  });
});
