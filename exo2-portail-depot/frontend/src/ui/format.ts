// L'API rend des instants ISO en UTC ; l'avocat lit des dates francaises. La
// conversion est faite ICI, une fois, plutot que dans chaque ecran : deux
// formats de date sur deux ecrans se lisent comme deux dates differentes.
const PARIS_DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const PARIS_DATE_AND_TIME_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function format_date(iso_instant: string): string {
  return PARIS_DATE_FORMAT.format(new Date(iso_instant));
}

export function format_date_and_time(iso_instant: string): string {
  return PARIS_DATE_AND_TIME_FORMAT.format(new Date(iso_instant));
}

export function has_expired(iso_instant: string, now: Date = new Date()): boolean {
  return new Date(iso_instant).getTime() <= now.getTime();
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

// Affichee en Mo parce que c'est l'unite dans laquelle un client lit la taille
// de ses fichiers. L'API, elle, ne parle qu'en octets.
export function format_megabytes(size_bytes: number): string {
  const megabytes: number = size_bytes / BYTES_PER_MEGABYTE;

  return `${megabytes >= 10 ? String(Math.round(megabytes)) : megabytes.toFixed(1).replace(/\.0$/, '')} Mo`;
}

const MIME_TYPE_LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
};

// Un type MIME affiche tel quel — `application/pdf` — n'apprend rien a un
// client ; le nom du format, si.
export function format_mime_types(mime_types: readonly string[]): string {
  return mime_types
    .map((mime_type: string) => MIME_TYPE_LABELS[mime_type] ?? mime_type)
    .join(', ');
}
