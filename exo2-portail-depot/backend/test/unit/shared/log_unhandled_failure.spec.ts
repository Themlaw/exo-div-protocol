import { HttpException, NotFoundException } from '@nestjs/common';
import { firstValueFrom, throwError, of } from 'rxjs';
import { UnhandledFailureLoggingInterceptor } from '../../../src/shared/log_unhandled_failure';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';

// Un vrai token de lien, pas un `xxx` : c'est sa forme — trente-deux caracteres
// tires au sort — qui doit declencher le masquage, et un faux token trop court
// ferait passer un test que la vraie valeur n'aurait pas passe.
const A_LINK_TOKEN = 'd2kVUAZCD4XBnNiDv8gNwAFtqrHvPn1i';

// L'intercepteur ne voit d'un appel que ce que Nest lui en donne : un contexte
// dont on n'exploite que la methode et le chemin.
function build_execution_context(method: string, url: string): never {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
  } as never;
}

function run_with_failure(
  interceptor: UnhandledFailureLoggingInterceptor,
  thrown: unknown,
): Promise<unknown> {
  return firstValueFrom(
    interceptor.intercept(build_execution_context('POST', `/api/v1/public/${A_LINK_TOKEN}/uploads`), {
      handle: () => throwError((): unknown => thrown),
    }),
  );
}

describe('UnhandledFailureLoggingInterceptor', () => {
  let logger: CapturingLogger;
  let interceptor: UnhandledFailureLoggingInterceptor;

  beforeEach(() => {
    logger = build_capturing_logger();
    interceptor = new UnhandledFailureLoggingInterceptor(logger);
  });

  it('journalise une panne imprevue', async () => {
    // La panne qui a motive cet intercepteur : une autorisation d'envoi rendait
    // 500 en production, et le journal ne portait AUCUNE trace de l'appel. Sans
    // trace, la seule facon de comprendre est de rejouer le scenario a la main.
    await expect(run_with_failure(interceptor, new Error('stockage injoignable'))).rejects.toThrow(
      'stockage injoignable',
    );

    const [entry] = logger.entries_at_level('error');
    expect(entry).toMatchObject({
      context: 'application',
      message: 'panne imprevue pendant le traitement d une requete',
      fields: {
        method: 'POST',
        // Le CHEMIN de la route, jamais l'URL telle quelle : un token de lien
        // vit dans le chemin, et le journal est lu par plus de monde que la base.
        path: '/api/v1/public/:segment/uploads',
        error_name: 'Error',
        error_message: 'stockage injoignable',
      },
    });
  });

  it('laisse passer une reponse d erreur VOULUE sans la journaliser', async () => {
    // Un 404 ou un 401 metier n'est pas une panne : les journaliser en `error`
    // noierait les vraies pannes sous le bruit du fonctionnement normal.
    await expect(run_with_failure(interceptor, new NotFoundException())).rejects.toBeInstanceOf(
      HttpException,
    );

    expect(logger.entries_at_level('error')).toHaveLength(0);
  });

  it('ne journalise rien quand tout se passe bien', async () => {
    await expect(
      firstValueFrom(
        interceptor.intercept(build_execution_context('GET', '/api/v1/requests'), {
          handle: () => of({ ok: true }),
        }),
      ),
    ).resolves.toEqual({ ok: true });

    expect(logger.captured_entries).toHaveLength(0);
  });

  it('remplace tout segment porteur de secret dans le chemin', async () => {
    // Le token d'un lien, l'identifiant d'une piece : le chemin d'une requete
    // publique porte des valeurs qui n'ont rien a faire dans un journal.
    await run_with_failure(interceptor, new Error('peu importe')).catch((): void => {});

    expect(logger.entries_at_level('error')[0]?.fields?.path).toBe(
      '/api/v1/public/:segment/uploads',
    );
  });
});
