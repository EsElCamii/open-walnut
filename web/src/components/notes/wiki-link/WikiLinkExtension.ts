/**
 * WikiLink Tiptap Extension — detects [[ input and triggers autocomplete.
 * Uses the same ProseMirror Plugin pattern as SlashCommandExtension.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export interface WikiLinkRange {
  from: number;
  to: number;
}

export type WikiLinkState =
  | { phase: 'closed' }
  | { phase: 'searching'; range: WikiLinkRange; query: string };

export interface WikiLinkOptions {
  onStateChange: (state: WikiLinkState) => void;
}

const WIKI_LINK_KEY = new PluginKey('wikiLink');

/**
 * Walk backwards from cursor position to find [[ trigger.
 * Returns the position of the first [ if valid, or -1.
 */
function findWikiLinkTrigger(text: string): number {
  // Find the last occurrence of [[
  const idx = text.lastIndexOf('[[');
  if (idx < 0) return -1;

  // Ensure [[ is at start of text or preceded by whitespace/punctuation
  if (idx > 0) {
    const charBefore = text[idx - 1];
    if (charBefore !== ' ' && charBefore !== '\t' && charBefore !== '\n' && charBefore !== '(') {
      return -1;
    }
  }

  // Ensure no ]] closing bracket in the query part
  const afterBrackets = text.slice(idx + 2);
  if (afterBrackets.includes(']]')) return -1;

  // Ensure no newline in the query (single-line only)
  if (afterBrackets.includes('\n')) return -1;

  return idx;
}

export const WikiLinkExtension = Extension.create<WikiLinkOptions>({
  name: 'wikiLink',

  addOptions() {
    return {
      onStateChange: () => {},
    };
  },

  addProseMirrorPlugins() {
    const { onStateChange } = this.options;
    let lastPhase: string = 'closed';

    return [
      new Plugin({
        key: WIKI_LINK_KEY,
        view() {
          return {
            update(view) {
              const { state } = view;
              const { selection } = state;

              // Only handle cursor selections (not ranges)
              if (!selection.empty) {
                if (lastPhase !== 'closed') {
                  lastPhase = 'closed';
                  onStateChange({ phase: 'closed' });
                }
                return;
              }

              const pos = selection.$from;
              const textBefore = pos.parent.textBetween(0, pos.parentOffset, undefined, '\ufffc');
              const triggerIdx = findWikiLinkTrigger(textBefore);

              if (triggerIdx < 0) {
                if (lastPhase !== 'closed') {
                  lastPhase = 'closed';
                  onStateChange({ phase: 'closed' });
                }
                return;
              }

              const query = textBefore.slice(triggerIdx + 2); // Text after [[
              const absoluteFrom = pos.start() + triggerIdx;
              const absoluteTo = pos.start() + pos.parentOffset;

              lastPhase = 'searching';
              onStateChange({
                phase: 'searching',
                range: { from: absoluteFrom, to: absoluteTo },
                query,
              });
            },
          };
        },
      }),
    ];
  },
});
