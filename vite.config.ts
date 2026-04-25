import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Dedupe React so a parent-vs-worktree node_modules layout (or any other
    // accidental dual-install) can't end up with two React copies in the
    // bundle, which would trip "Invalid hook call" in dev. Harmless on a
    // single-install setup.
    dedupe: ['react', 'react-dom'],
  },
});
