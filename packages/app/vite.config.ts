import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const buildWebUi = process.env['BUILD_WEBUI'] !== '0';

export default defineConfig({
  define: {
    __BUILD_WEBUI__: JSON.stringify(buildWebUi),
  },
  build: {
    target: 'node22',
    outDir: 'dist',
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        bin: resolve(__dirname, 'src/bin.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.mjs`,
    },
    rollupOptions: {
      external: [
        /^node:/,
        /^@qanyicat\//,
        'commander',
      ],
      output: {
        banner(chunk) {
          return chunk.fileName === 'bin.mjs' ? '#!/usr/bin/env node' : '';
        },
      },
    },
  },
  plugins: [dts({ entryRoot: 'src', outDir: 'dist' })],
});
