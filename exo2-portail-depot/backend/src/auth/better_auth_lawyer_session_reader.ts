import { fromNodeHeaders } from 'better-auth/node';
import type { LawyerAuth } from './lawyer_auth';
import type {
  IncomingRequestHeaders,
  LawyerSession,
  LawyerSessionReader,
} from './lawyer_session_reader';

export class BetterAuthLawyerSessionReader implements LawyerSessionReader {
  constructor(private readonly lawyer_auth: LawyerAuth) {}

  async read_lawyer_session(
    headers: IncomingRequestHeaders,
  ): Promise<LawyerSession | null> {
    const session = await this.lawyer_auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });

    if (session === null || session === undefined) {
      return null;
    }

    return {
      user_id: session.user.id,
      email: session.user.email,
      expires_at: session.session.expiresAt,
    };
  }
}
