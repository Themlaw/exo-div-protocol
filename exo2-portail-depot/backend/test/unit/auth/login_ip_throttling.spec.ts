import {
  count_failed_attempts_within_window,
  resolve_trusted_client_ip,
  LOGIN_IP_RATE_LIMIT_BOUNDS,
} from '../../../src/auth/login_throttling';

const NOW: Date = new Date('2026-09-07T12:00:00.000Z');
const WINDOW_SECONDS: number = LOGIN_IP_RATE_LIMIT_BOUNDS.window_seconds;

function seconds_before_now(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function seconds_after_now(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

describe('count_failed_attempts_within_window', () => {
  it('un tableau vide donne zero echec compte', () => {
    expect(count_failed_attempts_within_window([], NOW, WINDOW_SECONDS)).toBe(0);
  });

  it('des echecs tous a l\'interieur de la fenetre sont tous comptes', () => {
    const failure_timestamps: readonly Date[] = [
      seconds_before_now(1),
      seconds_before_now(WINDOW_SECONDS / 2),
      seconds_before_now(WINDOW_SECONDS - 1),
    ];

    expect(
      count_failed_attempts_within_window(failure_timestamps, NOW, WINDOW_SECONDS),
    ).toBe(3);
  });

  it(
    "des echecs anterieurs a la fenetre ne sont pas comptes : le compteur par IP decroit " +
      'avec le temps au lieu d\'etre remis a zero',
    () => {
      const failure_timestamps: readonly Date[] = [
        seconds_before_now(WINDOW_SECONDS + 1),
        seconds_before_now(WINDOW_SECONDS * 2),
      ];

      expect(
        count_failed_attempts_within_window(failure_timestamps, NOW, WINDOW_SECONDS),
      ).toBe(0);
    },
  );

  it('un melange d\'echecs dedans et dehors de la fenetre ne compte que ceux de la fenetre', () => {
    const failure_timestamps: readonly Date[] = [
      seconds_before_now(10),
      seconds_before_now(WINDOW_SECONDS + 10),
      seconds_before_now(WINDOW_SECONDS / 2),
      seconds_before_now(WINDOW_SECONDS * 3),
    ];

    expect(
      count_failed_attempts_within_window(failure_timestamps, NOW, WINDOW_SECONDS),
    ).toBe(2);
  });

  it(
    'cas limite exact : un echec a precisement now - window_seconds est encore dans la ' +
      'fenetre glissante et donc compte (borne inclusive retenue)',
    () => {
      const failure_timestamps: readonly Date[] = [seconds_before_now(WINDOW_SECONDS)];

      expect(
        count_failed_attempts_within_window(failure_timestamps, NOW, WINDOW_SECONDS),
      ).toBe(1);
    },
  );

  it(
    "un echec dont l'horodatage est dans le futur par rapport a now (horloge decalee) " +
      'reste traite comme recent et compte normalement : par securite, on ne sous-compte ' +
      "jamais une IP a cause d'un ecart d'horloge",
    () => {
      const failure_timestamps: readonly Date[] = [seconds_after_now(5)];

      expect(
        count_failed_attempts_within_window(failure_timestamps, NOW, WINDOW_SECONDS),
      ).toBe(1);
    },
  );

  it("l'ordre du tableau n'a pas d'importance : un meme jeu d'horodatages melange donne le meme resultat", () => {
    const in_order: readonly Date[] = [
      seconds_before_now(1),
      seconds_before_now(WINDOW_SECONDS / 2),
      seconds_before_now(WINDOW_SECONDS + 1),
    ];
    const shuffled: readonly Date[] = [in_order[2], in_order[0], in_order[1]];

    expect(
      count_failed_attempts_within_window(in_order, NOW, WINDOW_SECONDS),
    ).toBe(
      count_failed_attempts_within_window(shuffled, NOW, WINDOW_SECONDS),
    );
  });
});

// X-Forwarded-For est une liste dont le client controle entierement le debut : prendre la
// premiere entree laisserait n'importe qui changer d'identite a chaque requete et contourner
// ainsi toute limite par IP. On ne peut faire confiance qu'aux entrees ajoutees par un nombre
// declare de relais de confoance, en partant de la droite.
describe('resolve_trusted_client_ip', () => {
  it("avec une chaine vide et zero saut de confiance, l'adresse retenue est l'adresse directe de la connexion", () => {
    expect(resolve_trusted_client_ip([], '203.0.113.5', 0)).toBe('203.0.113.5');
  });

  it("avec un saut de confiance, l'adresse retenue est la DERNIERE entree de la chaine, pas la premiere", () => {
    const forwarded_for_chain: readonly string[] = ['198.51.100.7'];

    expect(
      resolve_trusted_client_ip(forwarded_for_chain, '10.0.0.1', 1),
    ).toBe('198.51.100.7');
  });

  it(
    "chaine forgee par le client : les premieres entrees sont controlees par l'attaquant, " +
      "avec un seul saut de confiance le resultat n'est jamais la valeur forgee '1.2.3.4' " +
      "que le client a inseree en tete",
    () => {
      const forwarded_for_chain: readonly string[] = ['1.2.3.4', '5.6.7.8', '10.0.0.1'];

      // `string | null` depuis la revue : une adresse non stockable ne doit pas
      // etre rendue telle quelle, l'INSERT du compteur echouerait.
      const result: string | null = resolve_trusted_client_ip(
        forwarded_for_chain,
        '203.0.113.9',
        1,
      );

      expect(result).not.toBe('1.2.3.4');
      expect(result).toBe('10.0.0.1');
    },
  );

  it(
    'une chaine plus courte que le nombre de sauts de confiance declares replie sur ' +
      "l'adresse directe de la connexion : un repli sur une valeur non controlee par le " +
      'client est le seul choix sur, une valeur choisie dans une chaine trop courte serait ' +
      'necessairement controlee ou incertaine',
    () => {
      const forwarded_for_chain: readonly string[] = ['198.51.100.7'];

      expect(
        resolve_trusted_client_ip(forwarded_for_chain, '203.0.113.9', 3),
      ).toBe('203.0.113.9');
    },
  );

  it('plusieurs sauts de confiance retiennent bien l\'entree correspondante en remontant depuis la droite', () => {
    const forwarded_for_chain: readonly string[] = [
      '1.1.1.1',
      '2.2.2.2',
      '3.3.3.3',
      '4.4.4.4',
    ];

    expect(
      resolve_trusted_client_ip(forwarded_for_chain, '203.0.113.9', 2),
    ).toBe('3.3.3.3');
  });

  it('les entrees avec des espaces autour sont normalisees avant d\'etre retenues', () => {
    const forwarded_for_chain: readonly string[] = ['1.2.3.4', '  5.6.7.8  '];

    expect(
      resolve_trusted_client_ip(forwarded_for_chain, '203.0.113.9', 1),
    ).toBe('5.6.7.8');
  });

  it(
    "une entree qui n'est pas une adresse IP valide ne doit pas etre retenue comme identite " +
      "de limitation : on replie sur l'adresse directe de la connexion plutot que de faire " +
      'confiance a une valeur non conforme (comportement attendu, non explicite dans le ' +
      'commentaire source : a confirmer)',
    () => {
      const forwarded_for_chain: readonly string[] = ['not-an-ip-address'];

      expect(
        resolve_trusted_client_ip(forwarded_for_chain, '203.0.113.9', 1),
      ).toBe('203.0.113.9');
    },
  );
});
