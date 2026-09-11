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
  type DemoAccessLinkRepository,
  type DemoDepositRequestBootstrapOutcome,
  type DemoDepositRequestRepository,
} from './demo_deposit_request_bootstrap';
import { ACCESS_LINK_REPOSITORY } from '../access_link/access_link_repository';
import {
  ACCESS_LINK_TOKEN_HASHER,
  type AccessLinkTokenHasher,
} from '../access_link/access_link_token_hasher';
import { CLIENT_PIN_HASHER } from '../access_link/client_pin_hasher';
import type { PinHasher } from '../domain/verify_client_pin';
import { CLOCK, type Clock } from '../shared/clock';
import { LAWYER_ACCOUNT_REPOSITORY } from '../auth/lawyer_auth.module';
import type { LawyerAccountRepository } from '../auth/lawyer_account_bootstrap';
import { APPLICATION_ENVIRONMENT, APPLICATION_PROCESS_ROLE } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import type { ApplicationProcessRole } from '../shared/process_role';
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
    @Inject(APPLICATION_PROCESS_ROLE) private readonly process_role: ApplicationProcessRole,
    @Inject(LAWYER_ACCOUNT_REPOSITORY)
    private readonly lawyer_accounts: LawyerAccountRepository,
    // Le type le plus ETROIT qui suffise, comme pour les liens et le journal :
    // l'amorcage compte les demandes de l'avocat et en cree une, il n'a aucune
    // raison de voir le reste du depot.
    @Inject(DEPOSIT_REQUEST_REPOSITORY)
    private readonly deposit_requests: DemoDepositRequestRepository,
    @Inject(ACCESS_LINK_REPOSITORY) private readonly access_links: DemoAccessLinkRepository,
    @Inject(ACCESS_LINK_TOKEN_HASHER) private readonly token_hasher: AccessLinkTokenHasher,
    @Inject(CLIENT_PIN_HASHER) private readonly pin_hasher: PinHasher,
    @Inject(ACTIVITY_EVENT_REPOSITORY)
    private readonly activity_events: ActivityEventRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Semer des donnees de demonstration n'est pas le metier du travailleur : il
    // execute des travaux. Les deux processus montent le meme module et
    // demarrent ensemble sur la meme base — chacun lisait « l'avocat n'a aucune
    // demande », chacun en creait une, et le second se brisait sur l'empreinte
    // du jeton de demonstration, qui est fixe par construction.
    if (this.process_role !== 'api') {
      return;
    }

    // Une donnee de demonstration ne doit JAMAIS empecher un processus de
    // demarrer — c'est deja la regle appliquee plus bas au compte avocat absent.
    // Faute de quoi un amorcage casse emporte avec lui la file de travaux, et
    // avec elle tout le scan.
    try {
      await this.seed_demo_deposit_request();
    } catch (seeding_failure: unknown) {
      this.logger.warn(DEPOSIT_LOG_CONTEXT, 'amorcage de la demande de demonstration abandonne', {
        error_message: seeding_failure instanceof Error ? seeding_failure.message : 'inconnu',
      });
    }
  }

  private async seed_demo_deposit_request(): Promise<void> {
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
      {
        owner_user_id,
        access_link_seed: {
          token: this.environment.demo_access_link_token,
          pin: this.environment.demo_access_pin,
        },
      },
      {
        deposit_requests: this.deposit_requests,
        access_links: this.access_links,
        token_hasher: this.token_hasher,
        pin_hasher: this.pin_hasher,
        activity_events: this.activity_events,
        clock: this.clock,
      },
    );

    // Ni le jeton ni le code n'apparaissent dans ce journal, bien qu'ils soient
    // publics : les journaux sont lus par plus de monde que la base, et une
    // exception pour la demonstration deviendrait la regle le jour ou quelqu'un
    // recopiera cette ligne pour une vraie emission.
    this.logger.info(
      DEPOSIT_LOG_CONTEXT,
      outcome.deposit_request_was_created
        ? 'demande de demonstration creee'
        : 'demande de demonstration non recreee : l avocat a deja des demandes',
      { access_link_was_issued: outcome.access_link_was_issued },
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
