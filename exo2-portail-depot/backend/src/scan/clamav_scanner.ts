import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import type { ScanVerdict } from '../domain/deposited_file';

export const FILE_SCANNER: unique symbol = Symbol('FILE_SCANNER');

export type ScannerAvailability = 'available' | 'unavailable';

export interface FileScanner {
  scan_stream(content: Readable): Promise<ScanVerdict>;

  // Existe pour la metrique `portail_clamav_up`, et passe par la MEME connexion
  // qu'un scan : si le PING repond, le scan repondra. Une sonde qui
  // interrogerait autre chose que le chemin reel finirait par etre verte
  // pendant une panne.
  probe_availability(): Promise<ScannerAvailability>;
}

export interface ClamavConnectionSettings {
  host: string;
  port: number;
  // Un scan qui ne rend rien doit finir par rendre `scanner_unavailable`
  // plutot que d'immobiliser un travailleur pour toujours.
  timeout_milliseconds: number;
}

// Le protocole INSTREAM de clamd : chaque bloc est precede de sa taille sur
// quatre octets en gros-boutiste, et un bloc de taille zero clot l'envoi.
const INSTREAM_TERMINATOR = Buffer.from([0, 0, 0, 0]);

// clamd refuse par defaut les blocs au-dela de 128 Ko (`StreamMaxLength` borne
// le total, pas le bloc, mais un bloc demesure fait fermer la connexion).
const INSTREAM_CHUNK_BYTES = 64 * 1024;

// Quinze secondes : un fichier de vingt megaoctets se scanne en quelques
// secondes, et au-dela c'est que clamd ne repond plus. Mieux vaut rendre la
// main et rejouer que garder un travailleur immobilise.
export const CLAMAV_SCAN_TIMEOUT_MILLISECONDS = 15_000;

const CLAMAV_ENDPOINT_PROTOCOL = 'tcp:';
const DEFAULT_CLAMAV_PORT = 3310;

// L'adresse arrive sous forme d'URL, comme celle de MinIO : une seule variable
// a renseigner, et une forme deja familiere.
export function parse_clamav_connection_settings(endpoint_url: string): ClamavConnectionSettings {
  const endpoint = new URL(endpoint_url);

  // `new URL('clamav:3310')` REUSSIT — il y lit un schema `clamav:` et un chemin
  // — et rend un `hostname` vide, sur lequel `net.connect` se rabat en silence
  // sur la boucle locale. Le scanner ne serait jamais joint, et le fail closed
  // transformerait une faute de frappe en file de scans qui ne finissent jamais.
  // Mieux vaut refuser de demarrer.
  if (endpoint.protocol !== CLAMAV_ENDPOINT_PROTOCOL || endpoint.hostname === '') {
    throw new Error(
      `CLAMAV_ENDPOINT doit etre de la forme ${CLAMAV_ENDPOINT_PROTOCOL}//hote:port`,
    );
  }

  return {
    host: endpoint.hostname,
    port: endpoint.port === '' ? DEFAULT_CLAMAV_PORT : Number(endpoint.port),
    timeout_milliseconds: CLAMAV_SCAN_TIMEOUT_MILLISECONDS,
  };
}

export class ClamavFileScanner implements FileScanner {
  constructor(private readonly settings: ClamavConnectionSettings) {}

  // FAIL CLOSED : toute panne — scanner absent, pas encore pret, connexion
  // coupee, reponse illisible — rend `scanner_unavailable`, jamais `clean`.
  // Le domaine laisse alors la piece en attente, et la reprise la reprendra.
  // Faire patienter vingt secondes vaut mieux qu'un fichier non scanne.
  async scan_stream(content: Readable): Promise<ScanVerdict> {
    let socket: Socket | undefined;

    try {
      socket = await this.open_connection();
      socket.write('zINSTREAM\0');

      for await (const chunk of content) {
        await write_instream_chunk(socket, chunk as Buffer);
      }
      socket.write(INSTREAM_TERMINATOR);

      return read_verdict(await read_response(socket));
    } catch {
      return 'scanner_unavailable';
    } finally {
      socket?.destroy();
      content.destroy();
    }
  }

  // La commande PING de clamd, qui repond PONG. Le delai est celui du scan :
  // une sonde plus patiente que le travail qu'elle couvre dirait vert alors que
  // chaque scan expire deja.
  async probe_availability(): Promise<ScannerAvailability> {
    let socket: Socket | undefined;

    try {
      socket = await this.open_connection();
      socket.write('zPING\0');

      return (await read_response(socket)).includes('PONG') ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    } finally {
      socket?.destroy();
    }
  }

  private async open_connection(): Promise<Socket> {
    const socket: Socket = connect({ host: this.settings.host, port: this.settings.port });
    socket.setTimeout(this.settings.timeout_milliseconds);
    // `timeout` ne coupe rien de lui-meme : sans cette destruction explicite,
    // une connexion muette resterait ouverte et la promesse ne se resoudrait
    // jamais.
    socket.on('timeout', (): void => {
      socket.destroy(new Error('clamd ne repond pas'));
    });

    await once(socket, 'connect');
    return socket;
  }
}

async function write_instream_chunk(socket: Socket, chunk: Buffer): Promise<void> {
  for (let offset = 0; offset < chunk.length; offset += INSTREAM_CHUNK_BYTES) {
    const slice: Buffer = chunk.subarray(offset, offset + INSTREAM_CHUNK_BYTES);
    const length_prefix: Buffer = Buffer.alloc(4);
    length_prefix.writeUInt32BE(slice.length, 0);

    // Respecte la contre-pression : ecrire sans attendre ferait grossir le
    // tampon de sortie jusqu'a la taille du fichier, exactement ce que le flux
    // existe pour eviter.
    if (!socket.write(Buffer.concat([length_prefix, slice]))) {
      await once(socket, 'drain');
    }
  }
}

async function read_response(socket: Socket): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of socket) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// clamd repond `stream: OK`, `stream: <signature> FOUND`, ou une erreur. Tout
// ce qui n'est pas explicitement l'un des deux premiers est traite comme une
// indisponibilite : une reponse qu'on ne comprend pas n'autorise rien.
function read_verdict(response: string): ScanVerdict {
  if (response.includes('FOUND')) {
    return 'infected';
  }
  if (/\bOK\b/.test(response)) {
    return 'clean';
  }
  return 'scanner_unavailable';
}
