import {
  route_database_notice,
  EXPECTED_MIGRATION_NOTICE_CODES,
  type DatabaseNotice,
  type DatabaseNoticeRouting,
} from '../../../src/db/database_notice';

describe('route_database_notice', () => {
  // Le point decisif, mesure sur Postgres 17.11 : un WARNING voyage dans le
  // MEME message NoticeResponse qu'un NOTICE. Un `onnotice` vide ne tait donc
  // pas seulement le bruit d'idempotence des migrations — il tait tous les
  // avertissements du serveur.
  it.each([
    ['un COMMIT hors transaction', { severity: 'WARNING', code: '25P01', message: 'there is no transaction in progress' }],
    ['un RAISE WARNING de plpgsql', { severity: 'WARNING', code: '01000', message: 'ceci est un avertissement serveur' }],
  ])('%s est journalise en warn, jamais ignore', (_label: string, notice: DatabaseNotice) => {
    expect(route_database_notice(notice)).toEqual<DatabaseNoticeRouting>({
      kind: 'logged',
      level: 'warn',
    });
  });

  it.each(EXPECTED_MIGRATION_NOTICE_CODES)(
    'le NOTICE %s, emis a chaque demarrage par le migrator, est ignore',
    (code: string) => {
      expect(route_database_notice({ severity: 'NOTICE', code, message: 'already exists, skipping' })).toEqual<DatabaseNoticeRouting>(
        { kind: 'ignored' },
      );
    },
  );

  it("un WARNING portant un code de la liste reste journalise : c'est la severite qui decide, pas le code", () => {
    expect(
      route_database_notice({ severity: 'WARNING', code: EXPECTED_MIGRATION_NOTICE_CODES[0] }),
    ).toEqual<DatabaseNoticeRouting>({ kind: 'logged', level: 'warn' });
  });

  it('un NOTICE ordinaire, comme un RAISE NOTICE de plpgsql, est journalise en debug', () => {
    expect(
      route_database_notice({ severity: 'NOTICE', code: '00000', message: 'notice depuis plpgsql' }),
    ).toEqual<DatabaseNoticeRouting>({ kind: 'logged', level: 'debug' });
  });

  it.each([
    ['INFO', 'debug'],
    ['LOG', 'debug'],
    ['DEBUG', 'debug'],
  ])('une severite %s est journalisee en %s', (severity: string, expected_level: string) => {
    expect(route_database_notice({ severity })).toEqual<DatabaseNoticeRouting>({
      kind: 'logged',
      level: expected_level as 'debug',
    });
  });

  // On ne tait que ce qu'on a explicitement decide de taire.
  it.each([
    ['une severite inconnue', { severity: 'QUELQUE_CHOSE_DE_NOUVEAU' }],
    ['une severite absente', {}],
    ['une severite vide', { severity: '' }],
  ])('%s est journalisee en warn, pas ignoree', (_label: string, notice: DatabaseNotice) => {
    expect(route_database_notice(notice)).toEqual<DatabaseNoticeRouting>({
      kind: 'logged',
      level: 'warn',
    });
  });

  it('la severite est comparee sans tenir compte de la casse', () => {
    expect(route_database_notice({ severity: 'warning' })).toEqual<DatabaseNoticeRouting>({
      kind: 'logged',
      level: 'warn',
    });
  });

  it('une severite ERROR resterait un avertissement au minimum : les vraies erreurs ne passent pas par ici, elles sont levees', () => {
    expect(route_database_notice({ severity: 'ERROR', code: '42P01' })).toEqual<DatabaseNoticeRouting>(
      { kind: 'logged', level: 'error' },
    );
  });
});
