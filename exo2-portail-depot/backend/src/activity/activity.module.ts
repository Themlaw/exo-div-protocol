import { Global, Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import {
  ACTIVITY_EVENT_REPOSITORY,
  DrizzleActivityEventRepository,
  type ActivityEventRepository,
} from './activity_event_repository';

// `@Global` : le journal sera ecrit depuis presque partout — liens, sessions,
// pieces, travailleur de scan. L'importer dans chacun de ces modules ne dirait
// rien de plus et ferait une ligne de cablage a oublier a chaque nouveau point
// d'ecriture.
@Global()
@Module({
  providers: [
    {
      provide: ACTIVITY_EVENT_REPOSITORY,
      inject: [APPLICATION_DATABASE],
      useFactory: (database: ApplicationDatabase): ActivityEventRepository =>
        new DrizzleActivityEventRepository(database),
    },
  ],
  exports: [ACTIVITY_EVENT_REPOSITORY],
})
export class ActivityModule {}
