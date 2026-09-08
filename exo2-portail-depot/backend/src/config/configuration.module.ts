import { Global, Module } from '@nestjs/common';
import {
  parse_application_environment,
  type ApplicationEnvironment,
} from './environment';

export const APPLICATION_ENVIRONMENT: unique symbol = Symbol('APPLICATION_ENVIRONMENT');

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
  ],
  exports: [APPLICATION_ENVIRONMENT],
})
export class ConfigurationModule {}
