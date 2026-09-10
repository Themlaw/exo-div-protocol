import { expect, test, type Page } from '@playwright/test';

import {
  create_deposit_request_through_the_form,
  open_the_deposit_link_as_an_anonymous_client,
  sign_in_as_the_demo_lawyer,
  type_the_access_code,
  type DeliveredAccessLink,
} from './helpers/deposit_journey';

// Le plus petit ecran que l'on s'engage a servir. « Non casse » ne suffit pas :
// c'est l'utilisabilite reelle qui est un critere d'evaluation.
const NARROW_PHONE_VIEWPORT = { width: 375, height: 812 } as const;

const A_SMALL_PDF = {
  name: 'attestation.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(`%PDF-1.4\n%${'x'.repeat(4096)}\n%%EOF\n`),
};

test.describe('Depot depuis un telephone etroit', () => {
  test('se deroule entierement a 375 px, sans debordement horizontal', async ({ page, browser }) => {
    await sign_in_as_the_demo_lawyer(page);
    const delivery: DeliveredAccessLink = await create_deposit_request_through_the_form(page, {
      title: `Dossier mobile ${String(Date.now())}`,
      document_label: 'Attestation',
    });

    const client_page: Page = await open_the_deposit_link_as_an_anonymous_client(
      browser,
      delivery.deposit_url,
      NARROW_PHONE_VIEWPORT,
    );

    await type_the_access_code(client_page, delivery.pin);
    await client_page.getByRole('button', { name: 'Ouvrir le depot' }).click();

    const slot = client_page.getByRole('listitem', { name: 'Attestation' });
    await expect(slot).toBeVisible();

    // Mesure AVANT le depot, et pas seulement apres : le declencheur de
    // selection de fichier n'existe plus une fois la piece deposee. La seule
    // mesure prise en fin de parcours regardait donc un ecran d'ou le controle
    // le plus large avait disparu — c'est ainsi qu'un debordement de six pixels
    // a traverse la chaine de verification sans etre vu.
    await expect_no_horizontal_overflow(client_page);

    await slot.getByLabel('Choisir un fichier pour Attestation').setInputFiles(A_SMALL_PDF);
    await slot.getByRole('button', { name: 'Envoyer Attestation' }).click();
    await expect(slot.getByText('Deposee')).toBeVisible({ timeout: 60_000 });

    await expect_no_horizontal_overflow(client_page);

    // Le geste final doit rester atteignable au pouce, pas seulement present
    // dans le document.
    const completion_button = client_page.getByRole('button', { name: 'Terminer le depot' });
    await expect(completion_button).toBeInViewport();
    await completion_button.click();

    const confirmation = client_page.getByRole('alertdialog');
    await expect(confirmation).toBeVisible();
    await expect_no_horizontal_overflow(client_page);
    await confirmation.getByRole('button', { name: 'Terminer' }).click();

    await expect(
      client_page.getByText('Votre depot a ete transmis. Les pieces ne peuvent plus etre modifiees.'),
    ).toBeVisible();

    await client_page.context().close();
  });
});

// Un debordement horizontal se lit comme une page cassee : le contenu part sous
// le bord droit et rien n'indique qu'il faut faire glisser.
async function expect_no_horizontal_overflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollable_width: document.documentElement.scrollWidth,
    visible_width: document.documentElement.clientWidth,
  }));

  expect(overflow.scrollable_width).toBeLessThanOrEqual(overflow.visible_width);
}
