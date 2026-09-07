// Le port revient ici, a la couche service — pas dans le domaine, ou chaque
// fonction ne lisait l'heure qu'une fois et prend donc `now: Date`.
// A ce niveau il gagne son cout : le limiteur de connexion lit l'heure de facon
// repetee et differee, et les tests doivent pouvoir la faire avancer sans
// dormir reellement ni manipuler l'horloge globale du processus.
export interface Clock {
  now(): Date;
}

export const CLOCK: unique symbol = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
