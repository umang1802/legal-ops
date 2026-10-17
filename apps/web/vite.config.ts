import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks: cached across app releases, and keeps the app chunk small.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('react-router')) return 'router';
          if (id.includes('@tanstack')) return 'query';
          if (/[\\/](zod|react-hook-form|@hookform)[\\/]/.test(id)) return 'forms';
          if (id.includes('lucide-react')) return 'icons';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5190,
    strictPort: true,
    // Same-origin in dev: the session cookie and CSRF flow behave exactly as in production behind one domain.
    proxy: { '/api': 'http://localhost:4100', '/health': 'http://localhost:4100' },
  },
});
