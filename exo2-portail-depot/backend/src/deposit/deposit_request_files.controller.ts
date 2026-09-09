import type { IncomingMessage } from 'node:http';
import {
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { require_lawyer_session } from '../auth/require_lawyer_session';
import {
  LAWYER_DOWNLOAD_AUTHORIZER,
  type LawyerDownloadAuthorizer,
  type LawyerDownloadOutcome,
} from '../deposited_file/authorize_lawyer_download';
import type { PresignedDownloadTicket } from '../object_storage/object_storage';

// Aucun decorateur d'acces : le defaut est 'lawyer'.
@Controller('requests/:deposit_request_id/files')
export class DepositRequestFilesController {
  constructor(
    @Inject(LAWYER_DOWNLOAD_AUTHORIZER)
    private readonly download_authorizer: LawyerDownloadAuthorizer,
  ) {}

  // Rend une URL, pas des octets : le fichier va du stockage au poste de
  // l'avocat sans traverser notre process. Les en-tetes qui forcent
  // l'enregistrement sont dans la signature de cette URL.
  @Get(':deposited_file_id/download')
  async authorize_deposited_file_download(
    @Req() request: IncomingMessage,
    @Param('deposit_request_id') deposit_request_id: string,
    @Param('deposited_file_id') deposited_file_id: string,
  ): Promise<PresignedDownloadTicket> {
    const outcome: LawyerDownloadOutcome = await this.download_authorizer.authorize({
      deposit_request_id,
      deposited_file_id,
      owner_user_id: require_lawyer_session(request).user_id,
    });

    // 404 sur ce qui n'est pas a lui : « pas a vous » et « n'existe pas » se
    // repondent de la meme facon, sinon l'identifiant devient un oracle.
    if (outcome.kind === 'unknown_file') {
      throw new NotFoundException();
    }

    // 409 en revanche sur SA piece : il la voit deja dans son detail avec son
    // statut, donc lui repondre 404 ne lui cacherait rien — cela l'empecherait
    // seulement d'afficher « en quarantaine » plutot que « introuvable ».
    if (outcome.kind === 'file_not_downloadable') {
      throw new ConflictException({ status: outcome.status });
    }

    return outcome.ticket;
  }
}
