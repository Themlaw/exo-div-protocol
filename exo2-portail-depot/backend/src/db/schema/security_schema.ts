import { index, inet, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
);
