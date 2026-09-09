import { sql } from 'drizzle-orm';
import {
  check,
  index,
  inet,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { MAXIMUM_LAWYER_EMAIL_LENGTH } from '../../shared/lawyer_credentials';

export const security_schema = pgSchema('security');

// Une seule table d'echecs par IP pour toutes les natures d'authentification :
// login avocat et PIN client se contournent exactement de la meme maniere,
// depuis une meme adresse, et une table par nature laisserait un attaquant
// alterner les deux pour rester sous chaque seuil.
export const authentication_failure_kind = security_schema.enum(
  'authentication_failure_kind',
  ['lawyer_login', 'client_pin'],
);

// Append-only : chaque echec est une ligne, jamais mise a jour. Deux raisons.
// D'abord la fenetre glissante se calcule alors par un simple COUNT borne dans
// le temps, evalue par l'horloge de Postgres. Ensuite l'insertion pure n'a
// aucune contention : deux echecs simultanes depuis la meme IP ne se marchent
// pas dessus, la ou un compteur incremente exigerait un verrou de ligne.
//
// Contrepartie assumee : la table croit indefiniment sans purge. Voir
// memories/auth-avocat.md — la purge au-dela de la fenetre est un chantier
// identifie, pas encore realise.
export const authentication_failure_by_ip = security_schema.table(
  'authentication_failure_by_ip',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client_ip: inet('client_ip').notNull(),
    failure_kind: authentication_failure_kind('failure_kind').notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Sert le comptage sur fenetre : filtre par IP et par nature, borne par le
    // temps. L'ordre des colonnes suit celui des predicats.
    index('authentication_failure_by_ip_window_idx').on(
      table.client_ip,
      table.failure_kind,
      table.occurred_at,
    ),
    // Sert la purge, qui balaie par age sans connaitre l'IP.
    index('authentication_failure_by_ip_occurred_at_idx').on(table.occurred_at),
  ],
);

// Table distincte de la precedente, et non une vue dessus : le compteur par
// compte se remet a zero apres une connexion reussie, celui par IP jamais. Les
// fusionner ferait qu'un attaquant disposant d'un compte legitime remettrait
// son budget par IP a zero a volonte.
//
// Une ligne par compte, incrementee par INSERT ... ON CONFLICT DO UPDATE : le
// calcul du nouveau compteur est fait par Postgres a partir de la valeur
// courante, sous le verrou de la ligne. Un lire-puis-ecrire cote application
// perdrait des echecs simultanes, ce qui est exactement ce qu'un attaquant
// parallelisant ses tentatives chercherait a provoquer.
//
// Clef primaire sur l'email et non sur l'identifiant utilisateur : une tentative
// sur un compte inexistant doit couter et compter la meme chose qu'une tentative
// sur un compte reel, sans quoi la table devient un oracle d'enumeration.
export const lawyer_login_failure_by_account = security_schema.table(
  'lawyer_login_failure_by_account',
  {
    email: text('email').primaryKey(),
    consecutive_failed_attempts: integer('consecutive_failed_attempts').notNull().default(0),
    last_failed_at: timestamp('last_failed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Ici la normalisation n'est pas une question de proprete : une casse non
    // rabattue donnerait un compteur distinct par variante, donc un
    // contournement pur et simple du backoff — il suffirait d'alterner
    // `demo@x.fr` et `Demo@x.fr`. Le code appelle normalize_lawyer_email avant
    // d'ecrire, mais un seul appelant qui l'oublie rouvrirait la faille en
    // silence, puisque la ligne s'insererait normalement.
    //
    // La borne de longueur compte autant : cette clef primaire recoit des
    // chaines entierement choisies par l'attaquant, puisqu'on compte aussi les
    // tentatives sur des comptes inexistants.
    // `btrim(x)` a un argument ne retire QUE l'espace U+0020, la ou
    // String.prototype.trim() en retire treize. Mesure lors de la revue :
    // tabulation, saut de ligne, espace insecable, marque d'ordre des octets et
    // huit autres passaient la contrainte — soit douze compteurs distincts pour
    // un meme compte, donc le contournement du backoff que cette contrainte
    // existe pour interdire. On exige donc la forme complete de l'adresse,
    // exactement comme has_lawyer_email_shape le fait cote code.
    check(
      'lawyer_login_failure_by_account_email_is_normalized',
      sql`${table.email} = lower(${table.email})
        AND ${table.email} ~ '^[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+@[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+\\.[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+$'
        AND length(${table.email}) <= ${sql.raw(String(MAXIMUM_LAWYER_EMAIL_LENGTH))}`,
    ),
    // Un ON CONFLICT DO UPDATE mal ecrit produirait un delai nul en silence.
    check(
      'lawyer_login_failure_by_account_attempts_is_not_negative',
      sql`${table.consecutive_failed_attempts} >= 0`,
    ),
  ],
);

// La couche PRINCIPALE du limiteur, et la seule des trois qui puisse refuser
// sans risque : elle compte le couple (compte vise, adresse d'origine).
// Refuser ici ne ferme rien pour l'avocat legitime, puisque l'attaquant occupe
// SON adresse et non celle de la victime — c'est exactement ce que le compteur
// par compte seul ne savait pas distinguer, et qui produisait le verrouillage
// permanent demontre par la revue du 2026-09-08.
//
// Table distincte plutot qu'une colonne ajoutee a l'une des deux precedentes :
// les trois compteurs n'ont ni la meme clef, ni la meme regle de remise a zero,
// ni la meme duree de vie. Les fusionner ferait dependre une regle de l'autre.
export const lawyer_login_failure_by_account_and_ip = security_schema.table(
  'lawyer_login_failure_by_account_and_ip',
  {
    email: text('email').notNull(),
    client_ip: inet('client_ip').notNull(),
    consecutive_failed_attempts: integer('consecutive_failed_attempts').notNull().default(0),
    last_failed_at: timestamp('last_failed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.email, table.client_ip] }),
    // Meme raison que sur la table par compte : une casse non rabattue donnerait
    // un compteur distinct par variante, donc le contournement pur et simple du
    // backoff. La contrainte tient meme si un appelant futur oublie d'appeler
    // normalize_lawyer_email.
    check(
      'lawyer_login_failure_by_account_and_ip_email_is_normalized',
      sql`${table.email} = lower(${table.email})
        AND ${table.email} ~ '^[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+@[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+\\.[^@[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+$'
        AND length(${table.email}) <= ${sql.raw(String(MAXIMUM_LAWYER_EMAIL_LENGTH))}`,
    ),
    check(
      'lawyer_login_failure_by_account_and_ip_attempts_is_not_negative',
      sql`${table.consecutive_failed_attempts} >= 0`,
    ),
    // Sert la purge, qui balaie par age sans connaitre la clef.
    index('lawyer_login_failure_by_account_and_ip_last_failed_at_idx').on(
      table.last_failed_at,
    ),
  ],
);
