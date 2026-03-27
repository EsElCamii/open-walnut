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
      exclude: ['**/*.live.test.ts'],
      testTimeout: 60_000,
    },
  }),
);
