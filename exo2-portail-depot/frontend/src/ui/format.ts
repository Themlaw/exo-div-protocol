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
