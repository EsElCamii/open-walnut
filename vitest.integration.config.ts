import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'path';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'web/src'),
        '@open-walnut/core': path.resolve(import.meta.dirname, 'src/core/types.ts'),
      },
    },
    test: {
      include: [
        'tests/commands/**/*.test.ts',
        'tests/integrations/**/*.test.ts',
        'tests/web/**/*.test.ts',
        'tests/session-server/**/*.test.ts',
      ],
      // notes-roundtrip drives the FRONTEND editor serializer; its deps live in
      // web/node_modules and it needs a DOM shim, so it runs under its own
      // vitest.notes-roundtrip.config.ts — never the node-env integration tier.
      exclude: ['**/*.live.test.ts', 'tests/web/notes-roundtrip/**'],
      testTimeout: 60_000,
    },
  }),
);
