export type ApplicationProcessRole = 'api' | 'worker';

// Le role est decide par le POINT D'ENTREE, jamais par l'environnement. `main.ts`
// et `worker_main.ts` montent le MEME `AppModule` — c'est voulu, deux cablages
// separes auraient diverge — et se retrouvent donc a executer les memes crochets
// de demarrage sur la meme base, en meme temps. Une variable d'environnement de
// plus serait une variable de plus a oublier dans le manifeste de deploiement,
// et on vient d'en faire les frais.
//
// Le defaut est `api` : un processus qui n'a rien declare sert des requetes.
// Seul le travailleur sait qu'il n'en sert aucune, et c'est a lui de le dire.
let declared_process_role: ApplicationProcessRole = 'api';

export function declare_worker_process(): void {
  declared_process_role = 'worker';
}

export function current_application_process_role(): ApplicationProcessRole {
  return declared_process_role;
}
