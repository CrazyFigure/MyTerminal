import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// 关于页需要展示前端包版本；构建时从 package.json 注入，避免界面版本号写死后和发版标签脱节。
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version ?? '0.1.2'),
  },
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
