import type { IncomingMessage } from 'node:http';
import {
  BadRequestException,
  InternalServerErrorException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { require_lawyer_session } from '../auth/require_lawyer_session';
import {
  parse_deposit_request_creation,
  type ParsedDepositRequestCreation,
} from './deposit_request_creation_payload';
import {
  ACCESS_LINK_ISSUER,
  type AccessLinkDelivery,
  type AccessLinkIssuer,
} from '../access_link/access_link_issuer';
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
    @Inject(ACCESS_LINK_ISSUER) private readonly access_link_issuer: AccessLinkIssuer,
  ) {}

  // La creation delivre IMMEDIATEMENT le couple lien + PIN, comme une clef
  // d'API : l'avocat repart de son formulaire avec le message a envoyer, en un
  // seul geste. Il ne le reverra jamais — le PIN est hache et le token n'est
  // stocke que sous forme de HMAC, le serveur en est incapable.
  @Post()
  async create_deposit_request(
    @Req() request: IncomingMessage,
    @Body() body: unknown,
  ): Promise<{ id: string; access_link: AccessLinkDelivery }> {
    const parsed: ParsedDepositRequestCreation = parse_deposit_request_creation(body);
    if (parsed.kind === 'invalid') {
      // Toutes les violations d'un coup, nommees : c'est le formulaire de
      // l'avocat en face, pas un attaquant, et rien de ce qu'on lui dit ne
      // renseigne sur autre chose que sa propre saisie.
      throw new BadRequestException({ violations: parsed.violations });
    }

    const owner_user_id: string = require_lawyer_session(request).user_id;
    const created_id: string = await this.deposit_requests.create({
      owner_user_id,
      creation: parsed.creation,
      security_policy: parsed.security_policy,
    });

    const delivery: AccessLinkDelivery | null =
      await this.access_link_issuer.issue_for_deposit_request({
        deposit_request_id: created_id,
        owner_user_id,
        deposit_request_title: parsed.creation.title.trim(),
        security_policy: parsed.security_policy,
      });

    // Impossible en pratique : la demande vient d'etre creee par cet avocat.
    // Un `null` ici signifierait que l'emission ne reconnait plus le
    // proprietaire — mieux vaut une erreur franche qu'une demande muette et
    // sans acces, qu'aucun ecran ne saurait rattraper.
    if (delivery === null) {
      throw new InternalServerErrorException();
    }

    return { id: created_id, access_link: delivery };
  }

  @Get()
  async list_deposit_requests(
    @Req() request: IncomingMessage,
  ): Promise<DepositRequestOverview[]> {
    return this.deposit_requests.list_overviews_for_owner(
      require_lawyer_session(request).user_id,
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
        require_lawyer_session(request).user_id,
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
}
