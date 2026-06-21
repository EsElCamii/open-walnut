/**
 * WikiLinkClick — renders inline `[[Title]]` / `[[folder/Title]]` text as a
 * clickable link inside the editor and reports the clicked target to React for
 * id-keyed resolution + navigation (Obsidian-native; the id NEVER appears in
 * link text — §2.2 / §3.5 of the contract).
 *
 * Two responsibilities, both via ONE ProseMirror plugin (no extra node — the
 * on-disk bytes stay plain `[[Title]]`, so the byte-clean round-trip is
 * untouched):
 *   1. Decorations: wrap each `[[…]]` run in a styled inline span so it looks
 *      and behaves like a link (cursor:pointer, accent color).
 *   2. handleClick: when a decorated span is clicked, extract the target text
 *      (the part before a real `|alias`) and hand it to `onLinkClick`. React
 *      resolves Title→note from the already-loaded list and navigates (or shows
 *      a disambiguation picker for an ambiguous bare `[[Title]]`).
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface WikiLinkClickOptions {
  /** Called with the raw target text (before any `|alias`) when a wiki-link is clicked. */
  onLinkClick: (target: string) => void;
}

const WIKI_LINK_CLICK_KEY = new PluginKey('wikiLinkClick');

// Matches `[[target]]` or `[[target|alias]]`; target excludes `]` and `|`.
// `g` so we can walk every occurrence within a text node.
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** The plugin attribute payload stored on each decoration for click extraction. */
interface WikiDecoSpec {
  target: string;
}

/** Build decorations marking every `[[…]]` run across all text nodes in the doc. */
function buildDecorations(doc: import('@tiptap/pm/model').Node): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    WIKI_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_RE.exec(text)) !== null) {
      const target = (m[1] || '').trim();
      if (!target) continue;
      const from = pos + m.index;
      const to = from + m[0].length;
      const alias = (m[2] || '').trim();
      decos.push(
        Decoration.inline(
          from,
          to,
          { class: 'notes-wikilink-ref', 'data-wikilink-target': target },
          // The spec carries the resolution target so the click handler can read
          // it without re-parsing; alias is purely display (rendered as text).
          { target: alias || target } as WikiDecoSpec,
        ),
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

export const WikiLinkClickExtension = Extension.create<WikiLinkClickOptions>({
  name: 'wikiLinkClick',

  addOptions() {
    return { onLinkClick: () => {} };
  },

  addProseMirrorPlugins() {
    const { onLinkClick } = this.options;
    return [
      new Plugin<DecorationSet>({
        key: WIKI_LINK_CLICK_KEY,
        state: {
          init: (_config, state) => buildDecorations(state.doc),
          // Only rebuild on a real doc change — cheap for typical note sizes,
          // and decorations must track positions as text shifts.
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return WIKI_LINK_CLICK_KEY.getState(state);
          },
          handleClick(view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest('.notes-wikilink-ref');
            const target = el?.getAttribute('data-wikilink-target');
            if (target) {
              event.preventDefault();
              onLinkClick(target);
              return true; // tell ProseMirror we handled it
            }
            return false;
          },
        },
      }),
    ];
  },
});
