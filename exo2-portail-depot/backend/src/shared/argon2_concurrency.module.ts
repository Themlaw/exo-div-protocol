import { Global, Module } from '@nestjs/common';
import {
  build_argon2_concurrency_gate,
  ARGON2_CONCURRENCY_GATE,
  type Argon2ConcurrencyGate,
} from './argon2_concurrency_gate';

// Global et fourni UNE SEULE FOIS pour tout le processus. C'est le coeur du
// raisonnement : le threadpool libuv est unique, donc le plafond doit l'etre
// aussi. Un portillon par surface — un pour la connexion avocat, un pour le PIN
// client — autoriserait huit hachages simultanes sur quatre fils, et le
// debordement retomberait sur des chemins qui n'ont rien a voir avec
// l'authentification.
//
// Consequence assumee : un pilonnage de PIN peut faire ATTENDRE un avocat qui
// se connecte. Attendre, pas etre refuse — la file est de 64 places et servie
// dans l'ordre d'arrivee, donc sans famine.
@Global()
@Module({
  providers: [
    {
      provide: ARGON2_CONCURRENCY_GATE,
      useFactory: (): Argon2ConcurrencyGate => build_argon2_concurrency_gate(),
    },
  ],
  exports: [ARGON2_CONCURRENCY_GATE],
})
export class Argon2ConcurrencyModule {}
