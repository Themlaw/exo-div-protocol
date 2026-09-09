import type { IncomingMessage } from 'node:http';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { read_authenticated_lawyer_session } from '../auth/route_access.guard';
import type { LawyerSession } from '../auth/lawyer_session_reader';
import {
  parse_deposit_request_creation,
  type ParsedDepositRequestCreation,
} from './deposit_request_creation_payload';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestDetail,
  type DepositRequestOverview,
  type DepositRequestRepository,
} from './deposit_request_repository';

// Aucun decorateur d'acces : le defaut est 'lawyer', donc le garde global exige
// une session sur les trois routes. Une route de ce controleur ajoutee demain
// sera fermee sans que personne ait a y penser.
@Controller('requests')
export class DepositRequestsController {
  constructor(
    @Inject(DEPOSIT_REQUEST_REPOSITORY)
    private readonly deposit_requests: DepositRequestRepository,
  ) {}

  @Post()
  async create_deposit_request(
    @Req() request: IncomingMessage,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    const parsed: ParsedDepositRequestCreation = parse_deposit_request_creation(body);
    if (parsed.kind === 'invalid') {
      // Toutes les violations d'un coup, nommees : c'est le formulaire de
      // l'avocat en face, pas un attaquant, et rien de ce qu'on lui dit ne
      // renseigne sur autre chose que sa propre saisie.
      throw new BadRequestException({ violations: parsed.violations });
    }

    return {
      id: await this.deposit_requests.create({
        owner_user_id: this.require_lawyer_session(request).user_id,
        creation: parsed.creation,
        security_policy: parsed.security_policy,
      }),
    };
  }

  @Get()
  async list_deposit_requests(
    @Req() request: IncomingMessage,
  ): Promise<DepositRequestOverview[]> {
    return this.deposit_requests.list_overviews_for_owner(
      this.require_lawyer_session(request).user_id,
    );
  }

  @Get(':id')
  async read_deposit_request(
    @Req() request: IncomingMessage,
    @Param('id') deposit_request_id: string,
  ): Promise<DepositRequestDetail> {
    const detail: DepositRequestDetail | null =
      await this.deposit_requests.find_detail_for_owner(
        deposit_request_id,
        this.require_lawyer_session(request).user_id,
      );

    // 404 et jamais 403, y compris pour une demande qui existe mais appartient a
    // un confrere : un 403 confirmerait son existence, et l'identifiant
    // deviendrait un oracle. « Pas a vous » et « n'existe pas » se repondent
    // de la meme facon.
    if (detail === null) {
      throw new NotFoundException();
    }

    return detail;
  }

  // Le garde a deja refuse la requete si la session manquait : arriver ici sans
  // session serait un garde debranche, pas une requete anonyme. On leve plutot
  // que de traiter la demande sans proprietaire.
  private require_lawyer_session(request: IncomingMessage): LawyerSession {
    const session: LawyerSession | null = read_authenticated_lawyer_session(request);
    if (session === null) {
      throw new NotFoundException();
    }
    return session;
  }
}
