// Le hachage Argon2 de @node-rs s'execute sur le threadpool de libuv, qui
// compte quatre fils par defaut. Au-dela de quatre hachages evalues en meme
// temps, les suivants n'accelerent rien : ils attendent un fil, tout en
// occupant une connexion Postgres et de la memoire. Pire, le threadpool sert
// AUSSI le reste du processus — un pilonnage ferait alors ramer des chemins qui
// n'ont rien a voir avec l'authentification.
//
// Le portillon est donc adosse a ARGON2, pas a la connexion : il borne aussi
// bien la connexion avocat que la verification du PIN client, qui paient le
// meme cout sur les memes quatre fils.
export const MAXIMUM_CONCURRENT_ARGON2_EVALUATIONS = 4;

// La file d'attente est bornee, sinon le plafond ne fait que deplacer le
// probleme : les requetes en trop s'accumuleraient en memoire au lieu de
// s'accumuler dans le threadpool.
export const MAXIMUM_QUEUED_ARGON2_EVALUATIONS = 64;

// Le refus n'arrive donc qu'une fois le plafond ET la file pleins. Refuser des
// le plafond atteint offrirait a l'attaquant un deni de service a quatre
// requetes : il suffirait d'occuper les quatre places pour que tout le monde
// recoive un 503.
//
// Une admission PORTE sa propre liberation, plutot que d'exposer un `leave()`
// que l'appelant devrait penser a n'appeler qu'une fois. Le portillon ne
// compte que des places : rien en lui ne pourrait rattacher une liberation a
// la requete qui l'avait prise, et deux appels pour une seule prise rendraient
// deux places — le plafond cesserait de plafonner sans qu'aucun test ne
// bronche. Un refus, lui, ne porte aucune liberation : il n'a rien pris.
export const ARGON2_CONCURRENCY_GATE: unique symbol = Symbol('ARGON2_CONCURRENCY_GATE');

export type Argon2ConcurrencyAdmission =
  | { kind: 'admitted'; release: () => void }
  | { kind: 'queue_full' };

export interface Argon2ConcurrencyGate {
  enter(): Promise<Argon2ConcurrencyAdmission>;
}

export interface Argon2ConcurrencyBounds {
  maximum_concurrent_evaluations: number;
  maximum_queued_evaluations: number;
}

export function build_argon2_concurrency_gate(
  bounds: Argon2ConcurrencyBounds = {
    maximum_concurrent_evaluations: MAXIMUM_CONCURRENT_ARGON2_EVALUATIONS,
    maximum_queued_evaluations: MAXIMUM_QUEUED_ARGON2_EVALUATIONS,
  },
): Argon2ConcurrencyGate {
  let evaluations_in_flight = 0;
  const waiting_admissions: ((admission: Argon2ConcurrencyAdmission) => void)[] = [];

  // La garantie « une place rendue une seule fois » vit ici, dans une fermeture
  // propre a chaque admission, et non dans une convention laissee a l'appelant.
  function admit(): Argon2ConcurrencyAdmission {
    let place_already_released = false;

    return {
      kind: 'admitted',
      release: (): void => {
        if (place_already_released) {
          return;
        }
        place_already_released = true;
        hand_over_or_free_one_place();
      },
    };
  }

  function hand_over_or_free_one_place(): void {
    const next_admission = waiting_admissions.shift();
    if (next_admission === undefined) {
      evaluations_in_flight -= 1;
      return;
    }

    // La place n'est pas rendue : elle change de titulaire.
    next_admission(admit());
  }

  return {
    enter: (): Promise<Argon2ConcurrencyAdmission> => {
      if (evaluations_in_flight < bounds.maximum_concurrent_evaluations) {
        evaluations_in_flight += 1;
        return Promise.resolve(admit());
      }

      if (waiting_admissions.length >= bounds.maximum_queued_evaluations) {
        return Promise.resolve({ kind: 'queue_full' });
      }

      return new Promise<Argon2ConcurrencyAdmission>((resolve): void => {
        waiting_admissions.push(resolve);
      });
    },
  };
}
