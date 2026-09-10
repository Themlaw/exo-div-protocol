// `vitest/config` et non `vite` : c'est lui qui connait la cle `test`.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Le front et l'API sont servis sur la MEME origine en production (Traefik
    // route /api vers le backend). Le mandataire de developpement reproduit
    // cela : sans lui, le cookie de session avocat serait tiers, et aucun
    // navigateur ne le renverrait.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
  },
});
