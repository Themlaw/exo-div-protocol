import type { ServerResponse } from 'node:http';
import { report_lawyer_auth_failure } from '../../../src/auth/mount_lawyer_auth';
import { build_capturing_logger } from '../../helpers/capturing_logger';

interface FakeServerResponse {
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, string>;
  body: string | null;
  destroyed: boolean;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
  destroy(): void;
}

function build_fake_response(headers_sent: boolean): FakeServerResponse {
  const response: FakeServerResponse = {
    headersSent: headers_sent,
    statusCode: 200,
    headers: {},
    body: null,
    destroyed: false,
    setHeader(name: string, value: string): void {
      response.headers[name] = value;
    },
    end(body?: string): void {
      response.body = body ?? '';
    },
    destroy(): void {
      response.destroyed = true;
    },
  };
  return response;
}

// BetterAuth est monte comme intergiciel, en amont du routeur Nest : aucun
// filtre d'exception ne s'applique a lui. Ce qui se passe quand son handler
// rejette n'est donc pas un detail d'implementation, c'est la seule chose qui
// separe un rejet non gere — donc un processus arrete — d'une reponse propre.
describe('report_lawyer_auth_failure', () => {
  it('journalise l echec en erreur, avec le contexte de l authentification', () => {
    const logger = build_capturing_logger();

    report_lawyer_auth_failure(
      new Error('base injoignable'),
      build_fake_response(false) as unknown as ServerResponse,
      logger,
    );

    expect(logger.entries_at_level('error')).toHaveLength(1);
    expect(logger.entries_at_level('error')[0]!.context).toBe('lawyer_auth');
  });

  it('repond 500 sans detail quand rien n a encore ete ecrit : la cause reste dans le journal', () => {
    const response = build_fake_response(false);

    report_lawyer_auth_failure(
      new Error('secret-a-ne-pas-divulguer'),
      response as unknown as ServerResponse,
      build_capturing_logger(),
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toBeNull();
    expect(response.body).not.toContain('secret-a-ne-pas-divulguer');
    expect(response.destroyed).toBe(false);
  });

  it(
    "coupe la connexion quand les en-tetes sont deja partis : y ecrire un statut leverait " +
      "a son tour, dans le gestionnaire d'erreur lui-meme",
    () => {
      const response = build_fake_response(true);

      report_lawyer_auth_failure(
        new Error('echec en cours de reponse'),
        response as unknown as ServerResponse,
        build_capturing_logger(),
      );

      expect(response.destroyed).toBe(true);
      expect(response.body).toBeNull();
      expect(response.statusCode).toBe(200);
    },
  );
});
