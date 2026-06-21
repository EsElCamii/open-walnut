/**
 * TagTrigger — detects `#` + letter input and notifies React so a frequency-
 * ranked tag autocomplete can be shown. Third clone of the proven
 * detect→range→autocomplete shape (SlashCommand / WikiLink). IME-safe: the
 * trigger runs in plugin view().update which fires AFTER composition commits.
 *
 * Trigger gate mirrors the parse rule: `#` at line start or after whitespace/`(`,
 * immediately followed by a letter (so `#1`, `C#`, and the `# ` heading shortcut
 * never open the menu).
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export interface TagRange {
  from: number;
  to: number;
}

export type TagTriggerState =
  | { phase: 'closed' }
  | { phase: 'searching'; range: TagRange; query: string };

export interface TagTriggerOptions {
  onStateChange: (state: TagTriggerState) => void;
}

const TAG_TRIGGER_KEY = new PluginKey('tagTrigger');

/** Find a `#tag` trigger ending at the cursor. Returns the `#` index or -1. */
function findTagTrigger(textBefore: string): number {
  for (let i = textBefore.length - 1; i >= 0; i--) {
    const ch = textBefore[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') return -1; // space breaks the tag
    if (ch === '#') {
      const before = i > 0 ? textBefore[i - 1] : null;
      const okBefore = before === null || before === ' ' || before === '\t' || before === '\n' || before === '(';
      if (!okBefore) return -1;
      // Must be followed by a letter to count as a tag start.
      const next = textBefore[i + 1];
      if (!next || !/[A-Za-z]/.test(next)) return -1;
      // Everything after must be valid tag-body chars (letters/digits/_/-/).
      if (!/^[A-Za-z][\w/-]*$/.test(textBefore.slice(i + 1))) return -1;
      return i;
    }
  }
  return -1;
}

export const TagTrigger = Extension.create<TagTriggerOptions>({
  name: 'tagTrigger',

  addOptions() {
    return { onStateChange: () => {} };
  },

  addProseMirrorPlugins() {
    const { onStateChange } = this.options;
    let lastPhase = 'closed';

    return [
      new Plugin({
        key: TAG_TRIGGER_KEY,
        view() {
          return {
            update(view) {
              const { state } = view;
              const { selection } = state;
              if (!selection.empty) {
                if (lastPhase !== 'closed') { lastPhase = 'closed'; onStateChange({ phase: 'closed' }); }
                return;
              }
              const pos = selection.$from;
              const textBefore = pos.parent.textContent.slice(0, pos.parentOffset);
              const idx = findTagTrigger(textBefore);
              if (idx < 0) {
                if (lastPhase !== 'closed') { lastPhase = 'closed'; onStateChange({ phase: 'closed' }); }
                return;
              }
              const query = textBefore.slice(idx + 1);
              const from = pos.start() + idx;
              const to = pos.start() + pos.parentOffset;
              lastPhase = 'searching';
              onStateChange({ phase: 'searching', range: { from, to }, query });
            },
          };
        },
      }),
    ];
  },
});
