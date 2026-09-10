import { expect, test, type Locator, type Page } from '@playwright/test';

import { DIV_BASE_COLORS, DIV_SURFACE_COLOR } from '../../src/theme/div_charter';

import {
  create_deposit_request_through_the_form,
  open_the_deposit_link_as_an_anonymous_client,
  sign_in_as_the_demo_lawyer,
  type_the_access_code,
  type DeliveredAccessLink,
} from './helpers/deposit_journey';

const A_SMALL_PDF = {
  name: 'cni.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(`%PDF-1.4\n%${'x'.repeat(4096)}\n%%EOF\n`),
};

test.describe('Parcours avocat de bout en bout', () => {
  test('cree une demande, la suit, et voit la piece arriver dans son journal', async ({
    page,
    browser,
  }) => {
    const deposit_request_title = `Dossier suivi ${String(Date.now())}`;

    await sign_in_as_the_demo_lawyer(page);
    const delivery: DeliveredAccessLink = await create_deposit_request_through_the_form(page, {
      title: deposit_request_title,
      document_label: "Piece d'identite",
    });

    // Le bouton primaire au SURVOL doit s'inverser — fond blanc, texte violet,
    // filet violet. C'est un critere d'evaluation explicite de la charte, et
    // jsdom ne peut pas le prouver : il ne calcule aucun pseudo-etat.
    const confirm_button = page.getByRole('alertdialog').getByRole('button', { name: 'Continuer' });

    expect(await read_painted_button(confirm_button)).toEqual({
      background: as_painted_color(DIV_BASE_COLORS.primary),
      color: as_painted_color(DIV_SURFACE_COLOR),
    });

    await confirm_button.hover();

    // `expect.poll` et non une lecture immediate : la recette anime la couleur
    // sur 0,18 s, et lire au premier instant du survol rend une teinte
    // intermediaire — un test qui echouerait au gre de la charge de la machine.
    await expect
      .poll(async () => read_painted_button(confirm_button))
      .toEqual({
        background: as_painted_color(DIV_BASE_COLORS.accent_surface),
        color: as_painted_color(DIV_BASE_COLORS.primary),
      });

    // Un premier clic sans avoir copie ne ferme rien : il avertit. Le PIN est
    // hache cote serveur, ferme sans etre copie il est perdu pour de bon.
    await confirm_button.click();
    await expect(
      page.getByText('Vous n avez pas copie le message. Fermer maintenant le perdra definitivement.'),
    ).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Fermer quand meme' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // La popup fermee mene au dashboard de la demande creee.
    await expect(page.getByRole('heading', { name: deposit_request_title })).toBeVisible();
    await expect(page.getByText('Lien de depot cree')).toBeVisible();

    const client_page: Page = await open_the_deposit_link_as_an_anonymous_client(
      browser,
      delivery.deposit_url,
    );
    await type_the_access_code(client_page, delivery.pin);
    await client_page.getByRole('button', { name: 'Ouvrir le depot' }).click();

    const slot = client_page.getByRole('listitem', { name: "Piece d'identite" });
    await slot.getByLabel("Choisir un fichier pour Piece d'identite").setInputFiles(A_SMALL_PDF);
    await slot.getByRole('button', { name: "Envoyer Piece d'identite" }).click();
    await expect(slot.getByText('Deposee')).toBeVisible({ timeout: 60_000 });

    // Cote avocat, la meme piece, vue de l'autre bout de la chaine.
    await page.reload();
    const lawyer_slot = page.getByRole('listitem', { name: "Piece d'identite" });
    await expect(lawyer_slot.getByText('cni.pdf')).toBeVisible({ timeout: 60_000 });
    await expect(lawyer_slot.getByText('Deposee')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Activite' }).getByText('Piece recue')).toBeVisible();

    await client_page.context().close();
  });
});

// Ce que le navigateur PEINT reellement, une fois la recette resolue et la
// transition terminee. jsdom ne calcule aucun pseudo-etat : l'inversion du
// bouton primaire ne peut se prouver qu'ici.
async function read_painted_button(
  button: Locator,
): Promise<{ background: string; color: string }> {
  return button.evaluate((element: Element) => {
    const painted = getComputedStyle(element);

    return { background: painted.backgroundColor, color: painted.color };
  });
}

// Les valeurs attendues viennent de la CHARTE, jamais recopiees a la main : une
// couleur ecrite en dur ici finirait par contredire `div_charter.ts` sans que
// rien ne le signale, et ce test existe justement pour tenir la charte.
function as_painted_color(hex_value: string): string {
  const [, red, green, blue] = /^#(..)(..)(..)$/.exec(hex_value) ?? [];

  return `rgb(${[red, green, blue].map((channel) => String(Number.parseInt(channel ?? '', 16))).join(', ')})`;
}
