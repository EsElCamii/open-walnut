/**
 * Headless DOM shim for the markdown round-trip corpus (IMPL-CONTRACT §6 / §7.1).
 *
 * Why a shim instead of jsdom: the repo's vitest tiers run in a `node` env and
 * neither `jsdom` nor `happy-dom` is installed (and the brief forbids
 * `npm install`). The round-trip pipeline we test, however, does NOT need a
 * rendered editor — only:
 *   1. `window.DOMParser` so `tiptap-markdown`'s parser can turn its rendered
 *      HTML into an element tree, and
 *   2. a `document` for `@tiptap/core`'s `generateJSON()` (it parses that HTML
 *      against the real schema via ProseMirror's DOMParser).
 * `linkedom` (already present transitively in the root node_modules) provides a
 * spec-faithful `DOMParser`/`document`/`Element` — exactly the parse surface the
 * production `Markdown` extension's parse/`updateDOM` hooks run against. We do
 * NOT mount a ProseMirror `EditorView`, so none of the layout/selection APIs
 * linkedom lacks are ever touched. This keeps the PRODUCTION serializer/parser
 * code the thing under test, with no behavioural stubs that could mask a bug.
 */

// linkedom lives in the repo-ROOT node_modules (a transitive dep), but this
// config runs with `root: web/`, so a bare `import 'linkedom'` would resolve
// against web/node_modules (absent). Reach the root copy with a relative path
// (portable — no machine-specific absolute path): this file is at
// tests/web/notes-roundtrip/, so ../../../ is the repo root.
import { parseHTML } from '../../../node_modules/linkedom/esm/index.js';

const { window, document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');

/**
 * linkedom's `DOMParser.parseFromString(html, 'text/html')` does NOT run HTML5
 * tree construction — it leaves block elements as siblings of `<body>` and
 * returns an empty `document.body`, which silently produced empty docs in the
 * round-trip pipeline. linkedom DOES parse correctly when assigning to an
 * existing node's `innerHTML` (htmlparser2-backed). `tiptap-markdown`'s
 * `elementFromString()` calls `new window.DOMParser().parseFromString(
 * '<body>'+html+'</body>', 'text/html').body`, so we provide a `DOMParser`
 * whose `parseFromString` builds the fragment via `innerHTML` INTO the single
 * persistent document (keeping `ownerDocument` stable so ProseMirror's own
 * `DOMParser.fromSchema(...).parse()` can later walk the same tree).
 */
class WorkingDOMParser {
  parseFromString(markup: string): { body: HTMLElement } {
    // Strip the single wrapping <body>…</body> tiptap-markdown adds; we re-host
    // the inner fragment in a real container element of the live document.
    const inner = markup.replace(/^<body>/i, '').replace(/<\/body>$/i, '');
    const container = document.createElement('body') as unknown as HTMLElement;
    (container as any).innerHTML = inner;
    return { body: container };
  }
}

// linkedom's `window` is a Proxy whose `get` trap returns its OWN (broken)
// `DOMParser` regardless of any `defineProperty` override — so we cannot patch
// the property in place. Instead wrap the window in a Proxy that returns our
// `WorkingDOMParser` for the `DOMParser` key and delegates everything else.
// `tiptap-markdown` reads `window.DOMParser` off the global `window`, so this
// wrapper is what must be exposed as `globalThis.window`.
const windowProxy = new Proxy(window as any, {
  get(target, prop, receiver) {
    if (prop === 'DOMParser') return WorkingDOMParser;
    return Reflect.get(target, prop, receiver);
  },
});

/**
 * linkedom's `HTMLInputElement` does NOT implement the reflected `.checked`
 * PROPERTY (it returns `undefined` regardless of the `checked` attribute), while
 * a real browser reflects it. `tiptap-markdown`'s task-item parse reads
 * `input.checked` to decide `data-checked` — so without this, a parsed
 * `- [ ] todo` would wrongly come back CHECKED. Define a faithful getter that
 * mirrors the `checked` attribute (the browser-equivalent behaviour), so the
 * corpus exercises the real serializer/parser instead of a DOM gap.
 */
{
  const probe = document.createElement('input') as any;
  const InputProto = Object.getPrototypeOf(probe);
  if (InputProto && !Object.getOwnPropertyDescriptor(InputProto, 'checked')) {
    Object.defineProperty(InputProto, 'checked', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('checked');
      },
      set(this: HTMLElement, v: boolean) {
        if (v) this.setAttribute('checked', '');
        else this.removeAttribute('checked');
      },
    });
  }
}

// Expose the DOM as globals the way a browser env would.
(globalThis as any).window = windowProxy;
(globalThis as any).document = document;
Object.defineProperty(globalThis as any, 'DOMParser', {
  value: WorkingDOMParser,
  configurable: true,
  writable: true,
});

// Node >= 21 exposes a read-only `navigator`; define it non-fatally.
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: (window as any).navigator ?? { userAgent: 'node' },
    configurable: true,
  });
} catch {
  /* a pre-existing navigator is fine */
}

// Mirror the handful of DOM constructors TipTap/ProseMirror reference by global.
// NOTE: `DOMParser` is intentionally absent — we installed the working override
// above; mirroring linkedom's broken one would clobber it.
const DOM_GLOBALS = [
  'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'Text',
  'XMLSerializer', 'getComputedStyle', 'MutationObserver',
  'Event', 'CustomEvent',
];
for (const key of DOM_GLOBALS) {
  const val = (window as any)[key];
  if (val && !(globalThis as any)[key]) {
    try { (globalThis as any)[key] = val; } catch { /* read-only global — skip */ }
  }
}
