import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Application } from './app';
import { create_query_client } from './api/query_client';

const application_root: HTMLElement | null = document.getElementById('root');

if (application_root === null) {
  throw new Error('Le point de montage #root est absent du document.');
}

createRoot(application_root).render(
  <StrictMode>
    <Application query_client={create_query_client()} />
  </StrictMode>,
);
