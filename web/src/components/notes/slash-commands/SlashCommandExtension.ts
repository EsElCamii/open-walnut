/**
 * Tiptap extension that detects "/" typed at the start of a line or after
 * whitespace and notifies React so a floating command panel can be shown.
 *
 * The extension tracks the range from the "/" to the cursor, allowing the
 * portal to replace the typed slash-query with the inserted content.
 *
 * Trigger-by-class (§3.3): we also report whether the "/" sits in an
 * empty/whitespace block. The menu uses this to hide block-insert commands
 * mid-sentence (a `/` after text only offers inline Reference entries), while
 * a `/` on a blank line offers the full block catalog.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { SlashCommandState } from './types';

export interface SlashCommandOptions {
  /** Includes `atBlockStart` so the menu can split block vs inline commands. */
  onStateChange: (state: SlashCommandState & { atBlockStart?: boolean }) => void;
}

const SLASH_COMMAND_KEY = new PluginKey('slashCommand');

/**
 * Find a valid slash trigger position in textBefore.
 * A valid trigger is "/" at position 0 or after whitespace, with no spaces
 * between the "/" and the cursor. Returns the index of "/" or -1.
 */
function findSlashTrigger(textBefore: string): number {
  // Walk backwards from cursor to find the nearest "/" preceded by whitespace or at line start
  for (let i = textBefore.length - 1; i >= 0; i--) {
    const ch = textBefore[i];
    // Hit a space before finding "/" — no trigger
    if (ch === ' ' || ch === '\t' || ch === '\n') return -1;
    if (ch === '/') {
      const charBefore = i > 0 ? textBefore[i - 1] : null;
      if (charBefore === null || charBefore === ' ' || charBefore === '\n' || charBefore === '\t') {
        return i;
      }
      // "/" exists but not preceded by whitespace — not a valid trigger
      return -1;
    }
  }
  return -1;
}

export const SlashCommandExtension = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      onStateChange: () => {},
    };
  },

  addProseMirrorPlugins() {
    const { onStateChange } = this.options;
    let active = false;

    function close() {
      if (active) {
        active = false;
        onStateChange({ phase: 'closed' });
      }
    }

    return [
      new Plugin({
        key: SLASH_COMMAND_KEY,

        view() {
          return {
            update(view) {
              const { state } = view;
              const { selection } = state;

              if (!selection.empty) { close(); return; }

              const pos = selection.$from;
              const textBefore = pos.parent.textContent.slice(0, pos.parentOffset);

              const slashIdx = findSlashTrigger(textBefore);
              if (slashIdx === -1) { close(); return; }

              const query = textBefore.slice(slashIdx + 1);

              const absoluteSlashPos = pos.start() + slashIdx;
              const absoluteCursorPos = pos.start() + pos.parentOffset;

              // Block-start = nothing but whitespace before the "/" in this block.
              // Only then do we offer block-insert commands; mid-sentence "/" still
              // fires (for inline Reference entries) but block commands are hidden.
              const atBlockStart = textBefore.slice(0, slashIdx).trim().length === 0;

              active = true;
              onStateChange({
                phase: 'commands',
                range: { from: absoluteSlashPos, to: absoluteCursorPos },
                query,
                atBlockStart,
              });
            },

            destroy() { close(); },
          };
        },
      }),
    ];
  },
});
