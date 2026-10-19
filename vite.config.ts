import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 约定：固定 1420 端口，忽略 src-tauri 目录避免热更新死循环
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
  },
});
