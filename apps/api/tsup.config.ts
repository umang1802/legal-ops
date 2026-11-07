import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  // Named entries keep dist flat: dist/server.js, dist/worker.js, and the one-off Vidhimeya importer, which runs on the
  // production box with plain node (node:sqlite is built into Node 22; see docs/runbooks/vidhimeya-billing-cutover.md).
  entry: { server: 'src/server.ts', worker: 'src/worker.ts', 'import-vidhimeya': 'src/scripts/import-vidhimeya.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TS source; bundle them. Real npm deps stay external.
  noExternal: [/^@legalops\//],
  // PDF fonts are read from disk at runtime (see billing/pdf/layout.ts): ship them next to the bundle.
  onSuccess: async () => {
    cpSync('assets', 'dist/assets', { recursive: true });
  },
});
