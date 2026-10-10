import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          ptyhost: resolve(__dirname, 'src/ptyhost/index.ts'),
          updatesplash: resolve(__dirname, 'src/updatesplash/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          updatesplash: resolve(__dirname, 'src/updatesplash/preload.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
