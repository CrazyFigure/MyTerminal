import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          if (id.includes('@monaco-editor') || id.includes('monaco-editor')) {
            return 'monaco-vendor';
          }

          if (id.includes('@xterm/')) {
            return 'xterm-vendor';
          }

          if (id.includes('react') || id.includes('scheduler')) {
            return 'react-vendor';
          }

          if (id.includes('lucide-react')) {
            return 'ui-vendor';
          }

          if (id.includes('@tauri-apps/')) {
            return 'tauri-vendor';
          }

          return 'vendor';
        },
      },
    },
  },
});
