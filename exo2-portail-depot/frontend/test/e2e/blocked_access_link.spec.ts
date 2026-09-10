import { expect, test, type Page } from '@playwright/test';

import {
  create_deposit_request_through_the_api,
  open_the_deposit_link_as_an_anonymous_client,
  sign_in_as_the_demo_lawyer,
  type_the_access_code,
  type DeliveredAccessLink,
} from './helpers/deposit_journey';

const MAXIMUM_PIN_ATTEMPTS = 5;
const A_WRONG_PIN = '000000';

test.describe('Lien bloque apres trop de codes errones', () => {
  test('refuse a l identique, puis bascule sur la demande d un nouveau lien', async ({
    page,
    browser,
  }) => {
    await sign_in_as_the_demo_lawyer(page);
    const delivery: DeliveredAccessLink = await create_deposit_request_through_the_api(
      page.request,
      {
        title: `Dossier a bloquer ${String(Date.now())}`,
        max_pin_attempts: MAXIMUM_PIN_ATTEMPTS,
      },
    );

    const client_page: Page = await open_the_deposit_link_as_an_anonymous_client(
      browser,
      delivery.deposit_url,
    );

    // Le vrai code est disponible et n'est jamais saisi : ce scenario prouve que
    // le blocage protege un lien dont le PIN est correct, pas seulement un lien
    // dont personne ne connait le code.
    expect(delivery.pin).not.toBe(A_WRONG_PIN);

    for (let attempt = 1; attempt < MAXIMUM_PIN_ATTEMPTS; attempt += 1) {
      await type_the_access_code(client_page, A_WRONG_PIN);
      await client_page.getByRole('button', { name: 'Ouvrir le depot' }).click();

      // La MEME phrase a chaque essai : rien ne doit dire combien il en reste,
      // sinon le compteur devient un oracle sur l'etat du lien.
      await expect(client_page.getByRole('alert')).toHaveText('Ce code ne correspond pas.');
    }

    await type_the_access_code(client_page, A_WRONG_PIN);
    await client_page.getByRole('button', { name: 'Ouvrir le depot' }).click();

    // L'essai qui ATTEINT le plafond bascule sur le message de blocage : c'est
    // la seule exception a l'indistinguabilite, et elle existe parce que le
    // client doit savoir qu'il lui faut un nouveau lien.
    await expect(
      client_page.getByText(/Ce lien a ete bloque.*demandez-en un nouveau/),
    ).toBeVisible();

    await client_page.reload();
    await expect(
      client_page.getByText(/Ce lien a ete bloque.*demandez-en un nouveau/),
    ).toBeVisible();
    await expect(client_page.getByLabel('Chiffre 1')).toHaveCount(0);

    await client_page.context().close();
  });
});
