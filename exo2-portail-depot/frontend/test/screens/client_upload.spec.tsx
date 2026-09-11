import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ClientDepositScreen } from '../../src/screens/client_deposit';
import { CLIENT_DEPOSIT_PATH } from '../../src/routing/front_routes';
import { render_screen } from '../helpers/render_screen';
import {
  DEPOSIT_ENTRY_PATH,
  UPLOAD_TICKET,
  json_response,
  stub_client_deposit_api,
  type ClientApiOverrides,
} from '../helpers/client_deposit_api';
import { stub_xml_http_request, type CapturedUpload } from '../helpers/fake_xml_http_request';

function a_pdf_named(filename: string, size_bytes: number = 1024): File {
  const file = new File(['x'], filename, { type: 'application/pdf' });

  Object.defineProperty(file, 'size', { value: size_bytes });

  return file;
}

function render_client_deposit(): void {
  render_screen(<ClientDepositScreen />, {
    route_path: CLIENT_DEPOSIT_PATH,
    entry_path: DEPOSIT_ENTRY_PATH,
  });
}

async function choose_a_file_for_the_identity_slot(file: File): Promise<HTMLElement> {
  const slot: HTMLElement = await screen.findByRole('listitem', { name: "Piece d'identite" });

  await userEvent.upload(
    within(slot).getByLabelText("Choisir un fichier pour Piece d'identite"),
    file,
  );

  return slot;
}

describe('Envoi d une piece par le client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('montre au client le nom du fichier qu il vient de choisir', async () => {
    // Le controle natif affichait ce nom tout seul. Il est remplace par un
    // declencheur habille — le natif s'annonce « Choose File » en anglais et
    // impose sa largeur —, donc c'est a l'ecran de redire ce qui est choisi :
    // sans ce nom, le client ne peut plus verifier qu'il envoie le bon fichier.
    stub_client_deposit_api();
    stub_xml_http_request();

    render_client_deposit();
    const slot: HTMLElement = await choose_a_file_for_the_identity_slot(a_pdf_named('cni.pdf'));

    expect(within(slot).getByText('cni.pdf')).toBeInTheDocument();
  });

  it('ne touche pas au reseau quand le client choisit son fichier', async () => {
    const fetch_spy = stub_client_deposit_api();
    stub_xml_http_request();

    render_client_deposit();
    await choose_a_file_for_the_identity_slot(a_pdf_named('cni.pdf'));

    // Changer d'avis avant d'appuyer ne doit rien couter, et surtout n'annuler
    // aucun transfert deja parti.
    expect(
      fetch_spy.mock.calls.filter((call: unknown[]) => String(call[0]).endsWith('/uploads')),
    ).toHaveLength(0);
  });

  it('demande son ticket puis pousse les octets vers le stockage, champs signes en tete', async () => {
    stub_client_deposit_api();
    const uploads: CapturedUpload[] = stub_xml_http_request();

    render_client_deposit();
    const slot: HTMLElement = await choose_a_file_for_the_identity_slot(a_pdf_named('cni.pdf'));
    await userEvent.click(within(slot).getByRole('button', { name: "Envoyer Piece d'identite" }));

    await waitFor(() => {
      expect(uploads).toHaveLength(1);
    });

    const upload: CapturedUpload = uploads[0] as CapturedUpload;
    expect(upload.method).toBe('POST');
    expect(upload.url).toBe(UPLOAD_TICKET.upload_url);

    // La politique pre-signee de S3 exige que le fichier soit le DERNIER champ :
    // les octets partent avant que le stockage ait lu la signature, sinon.
    const field_names: string[] = [...upload.form.keys()];
    expect(field_names).toEqual(['key', 'policy', 'file']);
  });

  it('rend compte de la progression jusqu au bout', async () => {
    stub_client_deposit_api();
    const uploads: CapturedUpload[] = stub_xml_http_request();

    render_client_deposit();
    const slot: HTMLElement = await choose_a_file_for_the_identity_slot(
      a_pdf_named('cni.pdf', 2000),
    );
    await userEvent.click(within(slot).getByRole('button', { name: "Envoyer Piece d'identite" }));
    await waitFor(() => {
      expect(uploads).toHaveLength(1);
    });

    const upload: CapturedUpload = uploads[0] as CapturedUpload;
    act(() => {
      upload.emit_progress(500, 2000);
    });

    expect(within(slot).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');

    act(() => {
      upload.emit_progress(2000, 2000);
    });

    expect(within(slot).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    act(() => {
      upload.finish(204);
    });

    // La barre DISPARAIT une fois le transfert fini. La laisser pleine a l'ecran
    // pendant l'analyse, puis apres le depot, en fait un ornement qui ne mesure
    // plus rien : c'est « Reception de la piece en cours… » qui prend le relais.
    await waitFor(() => {
      expect(within(slot).queryByRole('progressbar')).not.toBeInTheDocument();
    });
    expect(within(slot).getByRole('status')).toHaveTextContent(
      'Envoi termine. Reception de la piece en cours',
    );

    // Et les commandes restent fermees : rouvrir la selection entre la fin du
    // transfert et l'arrivee de la piece inviterait a envoyer deux fois.
    expect(within(slot).getByRole('button', { name: "Envoyer Piece d'identite" })).toBeDisabled();
  });

  it('dit la taille reelle autorisee quand le fichier est trop lourd', async () => {
    await expect_refusal_message(
      {
        upload_authorization: json_response(422, {
          reason: 'declared_size_above_limit',
          max_size_bytes: 5 * 1024 * 1024,
        }),
      },
      // La limite vient du backend, jamais du formulaire : c'est lui qui la
      // fait respecter, et la recopier ici la laisserait diverger.
      'Ce fichier depasse la taille autorisee pour cet emplacement (5 Mo).',
    );
  });

  it('liste les formats acceptes quand celui du fichier ne l est pas', async () => {
    await expect_refusal_message(
      {
        upload_authorization: json_response(422, {
          reason: 'mime_type_not_allowed',
          allowed_mime_types: ['application/pdf', 'image/jpeg'],
        }),
      },
      'Ce format n est pas accepte ici. Formats autorises : PDF, JPEG.',
    );
  });

  it('dit que la reception est en cours tant que le serveur ne compte pas la piece', async () => {
    stub_client_deposit_api();
    const uploads: CapturedUpload[] = stub_xml_http_request();

    render_client_deposit();
    const slot: HTMLElement = await choose_a_file_for_the_identity_slot(a_pdf_named('cni.pdf'));
    await userEvent.click(within(slot).getByRole('button', { name: "Envoyer Piece d'identite" }));
    await waitFor(() => {
      expect(uploads).toHaveLength(1);
    });

    act(() => {
      (uploads[0] as CapturedUpload).finish(204);
    });

    // Les octets sont partis, mais l'emplacement reste VIDE aux yeux du serveur
    // tant que le webhook MinIO n'a pas transforme la piece en occupante. Sans
    // ce message, le client croit son envoi perdu et recommence.
    expect(await within(slot).findByRole('status')).toHaveTextContent(
      'Envoi termine. Reception de la piece en cours',
    );
  });

  it('garde l echec sur le seul emplacement concerne', async () => {
    stub_client_deposit_api({
      upload_authorization: json_response(409, { message: 'Emplacement occupe' }),
    });
    stub_xml_http_request();

    render_client_deposit();
    const slot: HTMLElement = await choose_a_file_for_the_identity_slot(a_pdf_named('cni.pdf'));
    await userEvent.click(within(slot).getByRole('button', { name: "Envoyer Piece d'identite" }));

    await within(slot).findByRole('alert');

    // Un etat d'erreur partage ferait clignoter le message sur la mauvaise
    // ligne, et le client irait corriger le mauvais fichier.
    const other_slot: HTMLElement = screen.getByRole('listitem', {
      name: 'Justificatif de domicile',
    });
    expect(within(other_slot).queryByRole('alert')).not.toBeInTheDocument();
  });

  async function expect_refusal_message(
    overrides: ClientApiOverrides,
    expected_message: string,
  ): Promise<void> {
    stub_client_deposit_api(overrides);
    stub_xml_http_request();

    render_client_deposit();
    const slot: HTMLElement = await choose_a_file_for_the_identity_slot(a_pdf_named('cni.pdf'));
    await userEvent.click(within(slot).getByRole('button', { name: "Envoyer Piece d'identite" }));

    expect(await within(slot).findByRole('alert')).toHaveTextContent(expected_message);
  }
});
