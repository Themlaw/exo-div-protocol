import {
  build_login_concurrency_gate,
  type LoginConcurrencyAdmission,
  type LoginConcurrencyGate,
} from '../../../src/auth/login_concurrency_gate';

const SMALL_BOUNDS = {
  maximum_concurrent_evaluations: 2,
  maximum_queued_evaluations: 3,
} as const;

async function settled_kind_or_pending(
  admission: Promise<LoginConcurrencyAdmission>,
): Promise<LoginConcurrencyAdmission['kind'] | 'pending'> {
  return Promise.race([
    admission.then((settled: LoginConcurrencyAdmission) => settled.kind),
    // Une micro-tache suffit : une admission immediate se resout avant, une
    // admission en attente non.
    Promise.resolve().then((): 'pending' => 'pending'),
  ]);
}

async function admit_or_throw(gate: LoginConcurrencyGate): Promise<() => void> {
  const admission: LoginConcurrencyAdmission = await gate.enter();
  if (admission.kind !== 'admitted') {
    throw new Error(`admission attendue, recu ${admission.kind}`);
  }
  return admission.release;
}

describe('le plafond de concurrence de la connexion', () => {
  let gate: LoginConcurrencyGate;

  beforeEach(() => {
    gate = build_login_concurrency_gate(SMALL_BOUNDS);
  });

  it('admet immediatement tant que le plafond n est pas atteint', async () => {
    await expect(gate.enter()).resolves.toMatchObject({ kind: 'admitted' });
    await expect(gate.enter()).resolves.toMatchObject({ kind: 'admitted' });
  });

  // Refuser des le plafond atteint offrirait un deni de service a deux
  // requetes : occuper les places suffirait a fermer la connexion a tous.
  it('au-dela du plafond, la requete ATTEND au lieu d etre refusee', async () => {
    await admit_or_throw(gate);
    await admit_or_throw(gate);

    await expect(settled_kind_or_pending(gate.enter())).resolves.toBe('pending');
  });

  it('une place liberee est donnee au premier en attente, dans l ordre d arrivee', async () => {
    const first_release: () => void = await admit_or_throw(gate);
    const second_release: () => void = await admit_or_throw(gate);

    const first_waiter = gate.enter();
    const second_waiter = gate.enter();

    first_release();
    await expect(first_waiter).resolves.toMatchObject({ kind: 'admitted' });
    await expect(settled_kind_or_pending(second_waiter)).resolves.toBe('pending');

    second_release();
    await expect(second_waiter).resolves.toMatchObject({ kind: 'admitted' });
  });

  // La file bornee est ce qui empeche le plafond de simplement deplacer
  // l'accumulation du threadpool vers la memoire du processus.
  it('la file pleine, et alors seulement, la requete est refusee', async () => {
    const first_release: () => void = await admit_or_throw(gate);
    await admit_or_throw(gate);

    const queued: Promise<LoginConcurrencyAdmission>[] = [
      gate.enter(),
      gate.enter(),
      gate.enter(),
    ];

    await expect(gate.enter()).resolves.toEqual<LoginConcurrencyAdmission>({
      kind: 'queue_full',
    });

    // Les places en attente restent honorees : le refus ne les a pas perdues.
    first_release();
    await expect(queued[0]).resolves.toMatchObject({ kind: 'admitted' });
  });

  // LA propriete que l'ancienne API ne pouvait pas tenir : deux liberations
  // pour une seule prise auraient rendu deux places, et le plafond aurait
  // cesse de plafonner sans qu'aucun test ne bronche.
  it('liberer deux fois la meme admission ne rend qu une seule place', async () => {
    const release: () => void = await admit_or_throw(gate);
    await admit_or_throw(gate);

    release();
    release();
    release();

    await admit_or_throw(gate);
    await expect(settled_kind_or_pending(gate.enter())).resolves.toBe('pending');
  });

  // Un refus n'a pris aucune place : il ne doit donc pas pouvoir en rendre une.
  // Le type l'interdit desormais — ce test veille a ce qu'il continue.
  it("un refus ne porte aucune liberation", async () => {
    await admit_or_throw(gate);
    await admit_or_throw(gate);
    void gate.enter();
    void gate.enter();
    void gate.enter();

    const refused: LoginConcurrencyAdmission = await gate.enter();

    expect(refused).toEqual<LoginConcurrencyAdmission>({ kind: 'queue_full' });
    expect(Object.keys(refused)).toEqual(['kind']);
  });
});
