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
    // Deux processus, pas un par coeur : dix environnements jsdom lances
    // ensemble affament la machine, et `userEvent` — qui attend en horloge
    // reelle entre deux frappes — se met alors a depasser ses delais. Une suite
    // dont le resultat depend de la charge ne prouve rien.
    maxWorkers: 2,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
    // Les scenarios Playwright vivent sous `test/` comme tout le reste, mais ils
    // parlent a un vrai navigateur : lances par Vitest, ils echoueraient sur
    // l'absence de `@playwright/test`.
    exclude: ['test/e2e/**'],
  },
});
