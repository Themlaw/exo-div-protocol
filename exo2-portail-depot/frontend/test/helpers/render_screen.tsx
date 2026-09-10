import type { ReactElement, ReactNode } from 'react';
import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render } from '@testing-library/react';

import { div_system } from '../../src/theme/div_theme';

// Le `QueryClient` est neuf a chaque test et ne rejoue RIEN : un cache partage
// ferait passer un test grace a la reponse du precedent, et un rejeu
// transformerait une erreur attendue en attente de plusieurs secondes.
export function create_test_query_client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface RenderScreenOptions {
  readonly route_path?: string;
  readonly entry_path?: string;
  readonly extra_routes?: ReactNode;
}

export function render_screen(screen_element: ReactElement, options: RenderScreenOptions = {}): void {
  const route_path: string = options.route_path ?? '/';
  const entry_path: string = options.entry_path ?? route_path;

  render(
    <ChakraProvider value={div_system}>
      <QueryClientProvider client={create_test_query_client()}>
        <MemoryRouter initialEntries={[entry_path]}>
          <Routes>
            <Route path={route_path} element={screen_element} />
            {options.extra_routes}
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ChakraProvider>,
  );
}
