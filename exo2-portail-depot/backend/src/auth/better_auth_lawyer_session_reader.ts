import { fromNodeHeaders } from 'better-auth/node';
import type { Clock } from '../shared/clock';
import type { LawyerAuth } from './lawyer_auth';
import type {
  IncomingRequestHeaders,
  LawyerSession,
  LawyerSessionReader,
} from './lawyer_session_reader';

export class BetterAuthLawyerSessionReader implements LawyerSessionReader {
  constructor(
    private readonly lawyer_auth: LawyerAuth,
    private readonly clock: Clock,
  ) {}

  async read_lawyer_session(
    headers: IncomingRequestHeaders,
  ): Promise<LawyerSession | null> {
    const session = await this.lawyer_auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });

    if (session === null || session === undefined) {
      return null;
    }

    // L'expiration absolue est re-verifiee ICI, alors que la bibliotheque la
    // verifie deja. Ce n'est pas une redondance gratuite : c'est la propriete
    // de securite la plus importante de la session, et la seule que notre
    // horloge — donc nos tests — puisse observer, BetterAuth lisant `new Date()`
    // en interne. Une propriete qu'aucun test ne peut atteindre est une
    // propriete dont on ne sait rien.
    if (session.session.expiresAt.getTime() <= this.clock.now().getTime()) {
      return null;
    }

    return {
      user_id: session.user.id,
      email: session.user.email,
      expires_at: session.session.expiresAt,
    };
  }
}
