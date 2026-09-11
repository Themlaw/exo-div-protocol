import { expect, test, type Page } from '@playwright/test';

import {
  copy_the_message_and_close_the_dialog,
  create_deposit_request_through_the_form,
  open_the_deposit_link_as_an_anonymous_client,
  sign_in_as_the_demo_lawyer,
  type_the_access_code,
  type DeliveredAccessLink,
} from './helpers/deposit_journey';

const A_SMALL_PDF = {
  name: 'justificatif.pdf',
  mimeType: 'application/pdf',
  // Un vrai en-tete PDF : la detection de type cote serveur confronte le type
  // DETECTE a la liste blanche, et refuserait des octets quelconques annonces
  // en PDF.
  buffer: Buffer.from(`%PDF-1.4\n%${'x'.repeat(4096)}\n%%EOF\n`),
};

test.describe('Parcours client de bout en bout', () => {
  test('depose une piece, la voit analysee, puis termine son depot', async ({ page, browser }) => {
    await sign_in_as_the_demo_lawyer(page);
    const delivery: DeliveredAccessLink = await create_deposit_request_through_the_form(page, {
      title: `Dossier de bout en bout ${String(Date.now())}`,
      document_label: 'Justificatif de domicile',
    });

    // L'avocat copie son message et referme : c'est le geste reel, et c'est le
    // seul qui referme la popup du premier coup.
    await copy_the_message_and_close_the_dialog(page);

    const client_page: Page = await open_the_deposit_link_as_an_anonymous_client(
      browser,
      delivery.deposit_url,
    );

    await type_the_access_code(client_page, delivery.pin);
    await client_page.getByRole('button', { name: 'Ouvrir le depot' }).click();

    const slot = client_page.getByRole('listitem', { name: 'Justificatif de domicile' });
    await expect(slot).toBeVisible();

    await slot.getByLabel('Choisir un fichier pour Justificatif de domicile').setInputFiles(
      A_SMALL_PDF,
    );
    await slot.getByRole('button', { name: 'Envoyer Justificatif de domicile' }).click();

    // Le coeur de ce scenario : les octets vont du NAVIGATEUR a MinIO sans
    // passer par l'API. Une politique CORS fausse sur le bucket casse ici, et
    // nulle part ailleurs — aucun test backend ne voit passer cet envoi.
    //
    // La preuve est cette phrase et non plus une barre a 100 % : l'ecran ne
    // l'atteint qu'apres que l'envoi direct a REUSSI, et la barre s'efface
    // desormais a cet instant precis au lieu de rester pleine pendant toute
    // l'analyse. Le chemin d'echec, lui, n'affiche jamais ce message.
    await expect(slot.getByText('Envoi termine. Reception de la piece en cours')).toBeVisible();

    // Puis la chaine complete : notification MinIO, file de travaux, scan
    // antiviral, verdict. « Deposee » est ce que le client lit quand tout a
    // marche jusqu'au bout.
    await expect(slot.getByText('Deposee')).toBeVisible({ timeout: 60_000 });

    await client_page.getByRole('button', { name: 'Terminer le depot' }).click();
    await client_page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Terminer' })
      .click();

    await expect(
      client_page.getByText('Votre depot a ete transmis. Les pieces ne peuvent plus etre modifiees.'),
    ).toBeVisible();
    await expect(
      client_page.getByRole('button', { name: 'Terminer le depot' }),
    ).toHaveCount(0);

    await client_page.context().close();
  });
});
