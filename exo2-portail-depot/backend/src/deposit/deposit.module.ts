import { Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';
import { DepositRequestsController } from './deposit_requests.controller';
import { DepositRequestLinksController } from './deposit_request_links.controller';
import { DepositRequestActivityController } from './deposit_request_activity.controller';
import { DepositRequestFilesController } from './deposit_request_files.controller';
import { AccessLinkModule } from '../access_link/access_link.module';
import { DepositedFileModule } from '../deposited_file/deposited_file.module';
import {
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
} from '../deposited_file/deposited_file_repository';
import {
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  DrizzleDepositRequestRepository,
  type DepositRequestRepository,
} from './deposit_request_repository';
import {
  bootstrap_demo_deposit_request,
  type DemoDepositRequestBootstrapOutcome,
} from './demo_deposit_request_bootstrap';
import { LAWYER_ACCOUNT_REPOSITORY } from '../auth/lawyer_auth.module';
import type { LawyerAccountRepository } from '../auth/lawyer_account_bootstrap';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { APPLICATION_LOGGER } from '../shared/logging/logging.module';
import type { ApplicationLogger } from '../shared/logging/application_logger';

const DEPOSIT_LOG_CONTEXT = 'deposit';

// `onApplicationBootstrap` et non `onModuleInit`, et c'est tout le sujet : cet
// amorcage a besoin de l'identifiant du compte avocat, que l'amorcage du compte
// vient de creer dans SON `onModuleInit`. Nest garantit que tous les
// `onModuleInit` sont termines avant le premier `onApplicationBootstrap` ; en
// s'accrochant au meme crochet que l'autre, celui-ci dependrait d'un ordre
// d'initialisation entre modules que rien ne fixe, et la demande de
// demonstration n'apparaitrait qu'au deuxieme demarrage.
@Injectable()
export class DemoDepositRequestBootstrapper implements OnApplicationBootstrap {
  constructor(
    @Inject(APPLICATION_ENVIRONMENT) private readonly environment: ApplicationEnvironment,
    @Inject(LAWYER_ACCOUNT_REPOSITORY)
    private readonly lawyer_accounts: LawyerAccountRepository,
    @Inject(DEPOSIT_REQUEST_REPOSITORY)
    private readonly deposit_requests: DepositRequestRepository,
    @Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const owner_user_id: string | null = await this.lawyer_accounts.find_id_by_email(
      this.environment.demo_lawyer_email,
    );

    // Le compte est amorce juste avant, donc son absence ici ne peut venir que
    // d'un echec qu'on a deja journalise. Amorcer une demande sans proprietaire
    // n'a aucun sens : on s'abstient plutot que de lever et d'empecher le
    // demarrage pour une donnee de demonstration.
    if (owner_user_id === null) {
      return;
    }

    const outcome: DemoDepositRequestBootstrapOutcome = await bootstrap_demo_deposit_request(
      { owner_user_id },
      { deposit_requests: this.deposit_requests },
    );

    this.logger.info(
      DEPOSIT_LOG_CONTEXT,
      outcome.deposit_request_was_created
        ? 'demande de demonstration creee'
        : 'demande de demonstration non recreee : l avocat a deja des demandes',
    );
  }
}

@Module({
  imports: [AccessLinkModule, DepositedFileModule],
  controllers: [
    DepositRequestsController,
    DepositRequestLinksController,
    DepositRequestActivityController,
    DepositRequestFilesController,
  ],
  providers: [
    {
      provide: DEPOSIT_REQUEST_REPOSITORY,
      inject: [APPLICATION_DATABASE, DEPOSITED_FILE_REPOSITORY, ACTIVITY_EVENT_REPOSITORY],
      useFactory: (
        database: ApplicationDatabase,
        deposited_files: DepositedFileRepository,
        activity_events: ActivityEventRepository,
      ): DepositRequestRepository =>
        new DrizzleDepositRequestRepository(database, deposited_files, activity_events),
    },
    DemoDepositRequestBootstrapper,
  ],
  exports: [DEPOSIT_REQUEST_REPOSITORY],
})
export class DepositModule {}
