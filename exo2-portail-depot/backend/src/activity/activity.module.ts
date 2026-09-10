import { Global, Module } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { METRICS_REGISTRY, type MetricsRegistry } from '../observability/metrics';
import { MeteredActivityEventRepository } from '../observability/metered_activity_event_repository';
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
      inject: [APPLICATION_DATABASE, METRICS_REGISTRY],
      useFactory: (
        database: ApplicationDatabase,
        metrics: MetricsRegistry,
      ): ActivityEventRepository =>
        new MeteredActivityEventRepository(
          new DrizzleActivityEventRepository(database),
          metrics,
        ),
    },
  ],
  exports: [ACTIVITY_EVENT_REPOSITORY],
})
export class ActivityModule {}
