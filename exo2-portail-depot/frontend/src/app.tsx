import type { ReactElement } from 'react';
import { ChakraProvider } from '@chakra-ui/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { FRONT_ROUTES, guard_front_routes, type GuardedFrontRoute } from './routing/front_routes';
import { div_system } from './theme/div_theme';

export interface ApplicationProps {
  readonly query_client: QueryClient;
}

export function Application({ query_client }: ApplicationProps): ReactElement {
  return (
    <ChakraProvider value={div_system}>
      <QueryClientProvider client={query_client}>
        <BrowserRouter>
          <Routes>
            {guard_front_routes(FRONT_ROUTES).map((route: GuardedFrontRoute) => (
              <Route key={route.path} path={route.path} element={route.element} />
            ))}
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ChakraProvider>
  );
}
