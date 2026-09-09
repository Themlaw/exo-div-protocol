import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock, type Clock } from './clock';

// Global et fourni une seule fois : le harnais de test remplace ce seul
// fournisseur pour faire avancer le temps, et deux horloges distinctes dans
// l'application rendraient l'avancee partielle — donc les proprietes de
// decroissance invérifiables.
@Global()
@Module({
  providers: [{ provide: CLOCK, useFactory: (): Clock => new SystemClock() }],
  exports: [CLOCK],
})
export class ClockModule {}
