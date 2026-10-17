import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TS source; bundle them. Real npm deps stay external.
  noExternal: [/^@legalops\//],
});
