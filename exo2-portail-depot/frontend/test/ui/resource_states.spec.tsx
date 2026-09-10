import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChakraProvider } from '@chakra-ui/react';

import { ResourceStates } from '../../src/ui/resource_states';
import { div_system } from '../../src/theme/div_theme';

function render_within_the_theme(subject: React.ReactElement): void {
  render(<ChakraProvider value={div_system}>{subject}</ChakraProvider>);
}

const EMPTY_CALL_TO_ACTION = <button type="button">Creer une demande</button>;

describe('Etats d une ressource distante', () => {
  it('annonce le chargement aux lecteurs d ecran', () => {
    render_within_the_theme(
      <ResourceStates
        state="loading"
        loading_label="Chargement de vos demandes"
        error_message="Impossible de charger vos demandes."
        on_retry={vi.fn()}
        empty_message="Aucune demande pour l instant."
        empty_call_to_action={EMPTY_CALL_TO_ACTION}
      >
        <p>Contenu</p>
      </ResourceStates>,
    );

    // `role="status"` et non un simple texte : un avocat qui navigue au lecteur
    // d'ecran n'a aucun autre moyen d'apprendre que l'ecran travaille encore.
    expect(screen.getByRole('status')).toHaveTextContent('Chargement de vos demandes');
    expect(screen.queryByText('Contenu')).not.toBeInTheDocument();
  });

  it('offre de reessayer, et relance vraiment la requete', async () => {
    const retry = vi.fn();
    render_within_the_theme(
      <ResourceStates
        state="error"
        loading_label="Chargement de vos demandes"
        error_message="Impossible de charger vos demandes."
        on_retry={retry}
        empty_message="Aucune demande pour l instant."
        empty_call_to_action={EMPTY_CALL_TO_ACTION}
      >
        <p>Contenu</p>
      </ResourceStates>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Impossible de charger vos demandes.');
    await userEvent.click(screen.getByRole('button', { name: 'Reessayer' }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('distingue le vide de la panne, et propose la suite', () => {
    render_within_the_theme(
      <ResourceStates
        state="empty"
        loading_label="Chargement de vos demandes"
        error_message="Impossible de charger vos demandes."
        on_retry={vi.fn()}
        empty_message="Aucune demande pour l instant."
        empty_call_to_action={EMPTY_CALL_TO_ACTION}
      >
        <p>Contenu</p>
      </ResourceStates>,
    );

    // Un ecran vide sans issue laisse croire a une panne : le vide porte donc
    // toujours l'action qui le fait cesser.
    expect(screen.getByText('Aucune demande pour l instant.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Creer une demande' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('efface les trois etats des que le contenu est la', () => {
    render_within_the_theme(
      <ResourceStates
        state="ready"
        loading_label="Chargement de vos demandes"
        error_message="Impossible de charger vos demandes."
        on_retry={vi.fn()}
        empty_message="Aucune demande pour l instant."
        empty_call_to_action={EMPTY_CALL_TO_ACTION}
      >
        <p>Contenu</p>
      </ResourceStates>,
    );

    expect(screen.getByText('Contenu')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Aucune demande pour l instant.')).not.toBeInTheDocument();
  });
});
