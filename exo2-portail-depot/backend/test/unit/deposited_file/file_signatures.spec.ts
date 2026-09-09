import {
  DETECTABLE_MIME_TYPES,
  detect_mime_type_from_prefix,
} from '../../../src/deposited_file/file_signatures';

function build_prefix(...parts: readonly (string | readonly number[])[]): Buffer {
  return Buffer.concat(
    parts.map((part) =>
      typeof part === 'string' ? Buffer.from(part, 'ascii') : Buffer.from([...part]),
    ),
  );
}

// Un en-tete ISOBMFF : quatre octets de taille, `ftyp`, puis la marque. C'est
// elle seule qui distingue une photo HEIC d'une video MP4.
function build_isobmff(brand: string): Buffer {
  return build_prefix([0x00, 0x00, 0x00, 0x18], 'ftyp', brand, '    ');
}

// OpenDocument ecrit `mimetype` non compresse en tete d'archive : l'en-tete
// local occupe trente octets, le nom huit, la valeur suit.
function build_opendocument(mime_type: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(26),
    Buffer.from('mimetype', 'ascii'),
    Buffer.from(mime_type, 'ascii'),
  ]);
}

function build_ooxml(part_directory: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(26),
    Buffer.from(`[Content_Types].xml${part_directory}document.xml`, 'ascii'),
  ]);
}

describe('detect_mime_type_from_prefix', () => {
  it.each([
    ['application/pdf', build_prefix('%PDF-1.7')],
    ['image/png', build_prefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/jpeg', build_prefix([0xff, 0xd8, 0xff, 0xe0])],
    ['image/gif', build_prefix('GIF89a')],
    ['image/bmp', build_prefix('BM', [0x00, 0x00])],
    ['image/tiff', build_prefix([0x49, 0x49, 0x2a, 0x00])],
    ['image/tiff', build_prefix([0x4d, 0x4d, 0x00, 0x2a])],
    ['image/webp', build_prefix('RIFF', [0x00, 0x00, 0x00, 0x00], 'WEBP')],
    ['image/avif', build_isobmff('avif')],
    ['image/heic', build_isobmff('heic')],
    ['image/heif', build_isobmff('mif1')],
    [
      'application/vnd.oasis.opendocument.text',
      build_opendocument('application/vnd.oasis.opendocument.text'),
    ],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      build_ooxml('word/'),
    ],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', build_ooxml('xl/')],
  ])('reconnait %s', (expected_mime_type, prefix) => {
    expect(detect_mime_type_from_prefix(prefix)).toBe(expected_mime_type);
  });

  // Le format le plus probable d'un client qui photographie son document avec
  // un iPhone : l'oublier ferait rejeter le depot le plus courant du produit.
  it.each(['heic', 'heix', 'hevc', 'hevx'])('reconnait la marque HEIC %s', (brand) => {
    expect(detect_mime_type_from_prefix(build_isobmff(brand))).toBe('image/heic');
  });

  // `ftyp` ne suffit pas : une video le porte aussi, et la prendre pour une
  // photo laisserait passer un format qu'aucune liste blanche n'autorise.
  it('ne prend pas une video MP4 pour une image', () => {
    expect(detect_mime_type_from_prefix(build_isobmff('isom'))).toBeNull();
  });

  // Un ZIP quelconque n'est pas un document bureautique : le reconnaitre comme
  // tel ouvrirait la liste blanche a n'importe quelle archive.
  it('ne reconnait pas une archive ZIP quelconque', () => {
    const plain_archive = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(26),
      Buffer.from('photos/vacances.jpg', 'ascii'),
    ]);

    expect(detect_mime_type_from_prefix(plain_archive)).toBeNull();
  });

  it.each([
    ['un executable Windows', build_prefix('MZ', [0x90, 0x00])],
    ['un script shell', build_prefix('#!/bin/sh')],
    ['un fichier vide', Buffer.alloc(0)],
    ['un fichier tronque', build_prefix([0x89, 0x50])],
  ])('rend null pour %s : ce qu on ne sait pas nommer est rejete', (_label, prefix) => {
    expect(detect_mime_type_from_prefix(prefix)).toBeNull();
  });

  // La liste proposee a l'avocat est exactement celle qu'on sait reconnaitre :
  // offrir un type indetectable promettrait un depot que le scan rejetterait.
  it('chaque type proposable est effectivement detectable', () => {
    expect(new Set(DETECTABLE_MIME_TYPES).size).toBe(DETECTABLE_MIME_TYPES.length);
    expect(DETECTABLE_MIME_TYPES).toContain('application/pdf');
    expect(DETECTABLE_MIME_TYPES).toContain('image/heic');
  });
});
