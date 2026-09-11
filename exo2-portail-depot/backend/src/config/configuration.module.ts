import { Global, Module } from '@nestjs/common';
import {
  parse_application_environment,
  type ApplicationEnvironment,
} from './environment';
import {
  current_application_process_role,
  type ApplicationProcessRole,
} from '../shared/process_role';

export const APPLICATION_ENVIRONMENT: unique symbol = Symbol('APPLICATION_ENVIRONMENT');

// A cote de l'environnement parce que c'est la meme nature de fait : une donnee
// de demarrage, lue une fois, que le reste du code recoit par injection plutot
// que d'aller la chercher lui-meme.
export const APPLICATION_PROCESS_ROLE: unique symbol = Symbol('APPLICATION_PROCESS_ROLE');

// L'environnement est lu UNE fois, au demarrage, et jamais depuis `process.env`
// ailleurs dans le code. Deux lectures a des moments differents pourraient
// donner deux configurations, et une validation qui ne couvre pas tous les
// points de lecture ne valide rien.
@Global()
@Module({
  providers: [
    {
      provide: APPLICATION_ENVIRONMENT,
      useFactory: (): ApplicationEnvironment =>
        parse_application_environment(process.env),
    },
    {
      provide: APPLICATION_PROCESS_ROLE,
      useFactory: (): ApplicationProcessRole => current_application_process_role(),
    },
  ],
  exports: [APPLICATION_ENVIRONMENT, APPLICATION_PROCESS_ROLE],
})
export class ConfigurationModule {}
