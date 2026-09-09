import { Readable } from 'node:stream';
import {
  ClamavFileScanner,
  parse_clamav_connection_settings,
  type ClamavConnectionSettings,
} from '../../../src/scan/clamav_scanner';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';

// La signature de test standard de l'EICAR. Elle n'est pas un virus : c'est une
// chaine que tous les antivirus s'engagent a signaler, precisement pour qu'on
// puisse verifier qu'un scanner fonctionne sans manipuler de vrai code
// malveillant.
const EICAR_TEST_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('Scanner ClamAV', () => {
  const endpoint_url: string = process.env[ENVIRONMENT_VARIABLE_NAMES.clamav_endpoint] as string;

  function build_scanner(
    overrides: Partial<ClamavConnectionSettings> = {},
  ): ClamavFileScanner {
    return new ClamavFileScanner({
      ...parse_clamav_connection_settings(endpoint_url),
      ...overrides,
    });
  }

  it('declare sain un contenu sans signature connue', async () => {
    const verdict = await build_scanner().scan_stream(
      Readable.from([Buffer.from('%PDF-1.7\nun document parfaitement ordinaire\n')]),
    );

    expect(verdict).toBe('clean');
  });

  it("declare infecte un contenu portant la signature de test de l'EICAR", async () => {
    const verdict = await build_scanner().scan_stream(
      Readable.from([Buffer.from(EICAR_TEST_SIGNATURE)]),
    );

    expect(verdict).toBe('infected');
  });

  // La signature arrive coupee en trois morceaux de flux, donc en trois blocs
  // INSTREAM : c'est ce qui prouve que notre trame par bloc reconstitue bien le
  // contenu chez clamd, et n'en perd pas un octet aux jointures.
  it('trouve une signature coupee entre plusieurs blocs du flux', async () => {
    const signature: Buffer = Buffer.from(EICAR_TEST_SIGNATURE);

    const verdict = await build_scanner().scan_stream(
      Readable.from([
        signature.subarray(0, 20),
        signature.subarray(20, 45),
        signature.subarray(45),
      ]),
    );

    expect(verdict).toBe('infected');
  });

  it('scanne un contenu de plusieurs megaoctets sans le tronquer ni echouer', async () => {
    const large_content: Buffer = Buffer.alloc(8 * 1024 * 1024, 0x42);

    const verdict = await build_scanner().scan_stream(Readable.from([large_content]));

    expect(verdict).toBe('clean');
  });

  // LE test de securite du scanner : une panne ne doit jamais ressembler a un
  // fichier sain. Un `clean` rendu ici ferait promouvoir dans le bucket
  // definitif un fichier que personne n'a ouvert.
  it('rend scanner_unavailable, et jamais clean, quand clamd est injoignable', async () => {
    const verdict = await build_scanner({ port: 1 }).scan_stream(
      Readable.from([Buffer.from(EICAR_TEST_SIGNATURE)]),
    );

    expect(verdict).toBe('scanner_unavailable');
  });

  it('rend scanner_unavailable lorsque le scan depasse son delai', async () => {
    const verdict = await build_scanner({ timeout_milliseconds: 1 }).scan_stream(
      Readable.from([Buffer.alloc(8 * 1024 * 1024, 0x43)]),
    );

    expect(verdict).toBe('scanner_unavailable');
  });
});
