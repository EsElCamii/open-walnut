import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Dedicated config for the markdown round-trip corpus (IMPL-CONTRACT §6/§7.1).
 *
 * These tests drive the FRONTEND editor's serializer/parser, whose dependencies
 * (`tiptap-markdown`, `@tiptap/*`, `prosemirror-markdown`) live in `web/node_modules`,
 * not the repo root. Setting `root: web/` makes module resolution + the `@/` alias
 * behave exactly like the live Vite app. The DOM shim (`dom-setup.ts`) installs a
 * `linkedom`-backed `document`/`DOMParser` so the parse half runs headlessly — no
 * jsdom/happy-dom install required (the brief forbids `npm install`).
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'web/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Path is relative to `root` (web/).
    setupFiles: ['../tests/web/notes-roundtrip/dom-setup.ts'],
    include: ['../tests/web/notes-roundtrip/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
