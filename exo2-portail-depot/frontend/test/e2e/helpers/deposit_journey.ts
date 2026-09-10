import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

export interface DeliveredAccessLink {
  readonly deposit_url: string;
  readonly pin: string;
}

// Les identifiants du compte amorce au demarrage de l'application. Les lire dans
// l'environnement plutot que les recopier : `install.sh` les tire au sort, et un
// mot de passe fige ici ferait passer les tests sur une machine et echouer sur
// toutes les autres.
export function demo_lawyer_credentials(): { email: string; password: string } {
  const email: string | undefined = process.env.DEMO_LAWYER_EMAIL;
  const password: string | undefined = process.env.DEMO_LAWYER_PASSWORD;

  if (email === undefined || password === undefined) {
    throw new Error(
      'DEMO_LAWYER_EMAIL et DEMO_LAWYER_PASSWORD sont requis : lancez la suite avec le .env de la racine charge.',
    );
  }

  return { email, password };
}

export async function sign_in_as_the_demo_lawyer(page: Page): Promise<void> {
  const { email, password } = demo_lawyer_credentials();

  await page.goto('/login');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();

  await expect(page.getByRole('heading', { name: 'Mes demandes' })).toBeVisible();
}

// Le couple lien + code n'est rendu qu'UNE fois, dans la popup de creation. Le
// relire depuis le message affiche est donc le seul moyen d'en disposer — c'est
// aussi ce que fait l'avocat, qui copie ce meme texte.
export function read_delivered_access_link(message: string): DeliveredAccessLink {
  const deposit_url: string | undefined = /https?:\/\/\S+\/deposit\/\S+/.exec(message)?.[0];
  const pin: string | undefined = /Code d'acces : (\d+)/.exec(message)?.[1];

  if (deposit_url === undefined || pin === undefined) {
    throw new Error(`Message de delivrance illisible :\n${message}`);
  }

  return { deposit_url, pin };
}

export async function create_deposit_request_through_the_form(
  page: Page,
  input: { readonly title: string; readonly document_label: string },
): Promise<DeliveredAccessLink> {
  await page.getByRole('link', { name: 'Faire une nouvelle demande' }).first().click();
  await page.getByLabel('Titre de la demande').fill(input.title);

  const first_document = page.getByRole('group', { name: 'Document 1' });
  await first_document.getByLabel('Intitule').fill(input.document_label);
  await first_document.getByRole('checkbox', { name: 'PDF' }).check();

  await page.getByRole('button', { name: 'Creer la demande' }).click();

  const delivery_dialog = page.getByRole('alertdialog');
  await expect(delivery_dialog).toBeVisible();

  return read_delivered_access_link((await delivery_dialog.innerText()) ?? '');
}

// Cree la demande par l'API plutot que par le formulaire, et pour une seule
// raison : la politique de securite — le plafond d'essais de code — n'est pas
// encore reglable a l'ecran. La session avocat de la page porte la requete.
export async function create_deposit_request_through_the_api(
  api: APIRequestContext,
  input: { readonly title: string; readonly max_pin_attempts: number },
): Promise<DeliveredAccessLink> {
  const response = await api.post('/api/v1/requests', {
    data: {
      title: input.title,
      expected_documents: [
        {
          label: 'Piece unique',
          position: 1,
          allowed_mime_types: ['application/pdf'],
          max_size_bytes: 5 * 1024 * 1024,
        },
      ],
      security_policy: {
        max_pin_attempts: input.max_pin_attempts,
        link_lifetime_days: 7,
        pin_length: 6,
      },
    },
  });

  expect(response.status()).toBe(201);
  const created = (await response.json()) as { access_link: { url: string; pin: string } };

  return { deposit_url: created.access_link.url, pin: created.access_link.pin };
}

// La popup ne se ferme pas d'un simple clic tant que le message n'a pas ete
// copie : elle previent d'abord, parce que le code n'est plus jamais affiche.
// Le scenario emprunte donc le meme chemin que l'avocat.
export async function copy_the_message_and_close_the_dialog(page: Page): Promise<void> {
  const delivery_dialog = page.getByRole('alertdialog');

  await delivery_dialog.getByRole('button', { name: 'Copier le message' }).click();
  await delivery_dialog.getByRole('button', { name: 'Continuer' }).click();
  await expect(delivery_dialog).toHaveCount(0);
}

export async function open_the_deposit_link_as_an_anonymous_client(
  browser: Browser,
  deposit_url: string,
  viewport?: { readonly width: number; readonly height: number },
): Promise<Page> {
  // Un contexte NEUF : le cookie de session avocat n'a rien a faire dans le
  // navigateur du client, et le garder ferait passer un test qui echouerait chez
  // le vrai destinataire.
  const context = await browser.newContext(viewport === undefined ? {} : { viewport });
  const page: Page = await context.newPage();

  await page.goto(deposit_url);

  return page;
}

export async function type_the_access_code(page: Page, pin: string): Promise<void> {
  for (const [index, digit] of [...pin].entries()) {
    await page.getByLabel(`Chiffre ${String(index + 1)}`).fill(digit);
  }
}
