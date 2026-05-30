import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist',
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'config/index': resolve(__dirname, 'src/config/index.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.mjs`,
    },
    rollupOptions: {
      external: [
        /^node:/,
        'inversify',
        'reflect-metadata',
        'winston',
        'winston-transport',
        '@sinclair/typebox',
        '@sinclair/typebox/value',
      ],
    },
  },
  plugins: [dts({ entryRoot: 'src', outDir: 'dist', rollupTypes: false })],
});
