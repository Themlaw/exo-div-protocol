import { Global, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../shared/clock';
import {
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import { DepositModule } from './deposit.module';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestRepository,
} from './deposit_request_repository';
import {
  DEPOSIT_REQUEST_LIFECYCLE,
  DepositRequestLifecycleService,
  type DepositRequestLifecycle,
} from './deposit_request_lifecycle';

// `@Global` : cinq chemins tres eloignes font evoluer le statut d'une demande —
// un verdict de scan, un retrait, un blocage de lien, une expiration constatee,
// un client qui annonce avoir fini. Les faire tous importer le meme module
// n'aurait ajoute que des lignes d'import.
@Global()
@Module({
  imports: [DepositModule],
  providers: [
    {
      provide: DEPOSIT_REQUEST_LIFECYCLE,
      inject: [DEPOSIT_REQUEST_REPOSITORY, ACTIVITY_EVENT_REPOSITORY, CLOCK],
      useFactory: (
        deposit_requests: DepositRequestRepository,
        activity_events: ActivityEventRepository,
        clock: Clock,
      ): DepositRequestLifecycle =>
        new DepositRequestLifecycleService({ deposit_requests, activity_events, clock }),
    },
  ],
  exports: [DEPOSIT_REQUEST_LIFECYCLE],
})
export class DepositRequestLifecycleModule {}
