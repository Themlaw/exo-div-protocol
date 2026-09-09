const FALLBACK_DOWNLOAD_FILE_NAME = 'document';

// Le nom vient de celui qui depose : il peut contenir des retours a la ligne,
// des guillemets, un chemin. Sans nettoyage, il fabrique des en-tetes — un
// `Set-Cookie` glisse dans un nom de fichier serait pose par le navigateur.
function sanitize_download_file_name(file_name: string): string {
  const last_path_segment: string = file_name.split(/[\\/]/).pop() ?? '';

  // eslint-disable-next-line no-control-regex
  const without_control_characters: string = last_path_segment.replace(/[\u0000-\u001f\u007f]/g, '');
  const without_quotes: string = without_control_characters.replace(/["\\]/g, '');
  const trimmed: string = without_quotes.trim();

  return trimmed === '' || trimmed === '.' || trimmed === '..'
    ? FALLBACK_DOWNLOAD_FILE_NAME
    : trimmed;
}

// La forme simple reste lisible par tous les clients, la forme encodee (RFC
// 5987) porte le nom reel : un nom accentue n'a aucune raison d'etre perdu, et
// le client n'a aucune raison de deposer en ASCII.
function build_content_disposition(file_name: string): string {
  const sanitized_file_name: string = sanitize_download_file_name(file_name);
  const ascii_fallback: string = sanitized_file_name.replace(/[^\x20-\x7e]/g, '_');

  return [
    'attachment',
    `filename="${ascii_fallback}"`,
    `filename*=UTF-8''${encodeURIComponent(sanitized_file_name)}`,
  ].join('; ');
}

export const DOWNLOAD_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, private';

// Force a un flux binaire, quel que soit le type declare au depot. Mesure sur
// le MinIO du projet : un objet depose en `text/html` est rendu tel quel par un
// GET presigne, donc EXECUTE comme une page a l'origine du stockage. Le type
// reel n'apporte rien ici — le fichier est destine a etre enregistre.
export const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

// Ces trois en-tetes ne valent QUE pour un telechargement, et c'est pourquoi ils
// ne sont pas dans le durcissement global :
// - `attachment` empeche un document depose de s'ouvrir DANS notre origine,
//   c'est-a-dire le XSS stocke que craint un portail de depot ;
// - `no-store` evite qu'une piece juridique reste sur le disque du navigateur
//   apres la deconnexion, ou dans le cache d'un intermediaire ;
// - `same-origin` empeche un autre site de charger la piece en sous-ressource.
export function build_download_response_headers(
  file_name: string,
): Readonly<Record<string, string>> {
  return {
    'content-disposition': build_content_disposition(file_name),
    'cache-control': DOWNLOAD_CACHE_CONTROL,
    'cross-origin-resource-policy': 'same-origin',
  };
}

// Les octets d'un telechargement presigne ne passent JAMAIS par notre
// application : ils vont du navigateur au stockage. Aucun en-tete pose par nous
// ne les accompagne, et `build_download_response_headers` ne s'appliquerait
// qu'a une voie ou nous relayons le fichier nous-memes.
//
// La meme protection se porte donc en parametres `response-*` de l'URL
// presignee. Ils entrent dans la SIGNATURE : verifie sur le MinIO du projet,
// les modifier apres coup rend 403, donc le client ne peut pas retourner
// `attachment` en `inline`. Les valeurs viennent des memes constantes que la
// voie servie par nous, pour que les deux ne divergent pas.
export function build_presigned_download_response_overrides(
  file_name: string,
): Readonly<Record<string, string>> {
  return {
    'response-content-disposition': build_content_disposition(file_name),
    'response-cache-control': DOWNLOAD_CACHE_CONTROL,
    'response-content-type': DOWNLOAD_CONTENT_TYPE,
  };
}
