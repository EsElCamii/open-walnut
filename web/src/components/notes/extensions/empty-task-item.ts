/**
 * TaskItem with an empty-aware markdown serializer (the serialize half of the
 * orphan-checkbox round-trip — see notes-content-preprocess.ts for the parse
 * half).
 *
 * tiptap-markdown's built-in `taskItem` serializer writes `"[ ] "` then
 * renderContent(node). For an EMPTY item that content is just the ZWSP we
 * injected to make it parse, so the naive output would be `- [ ] ​` — not the
 * original `- [ ]`. Here we detect an empty (or ZWSP-only) item and write the
 * bare `[ ]` / `[x]`, so a never-edited orphan checkbox round-trips byte-clean.
 */
import TaskItem from '@tiptap/extension-task-item';
import { ZWSP } from '../notes-content-preprocess';

export const EmptyAwareTaskItem = TaskItem.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const check = node.attrs.checked ? '[x]' : '[ ]';
          // Is the item visually empty? (no text, or only the ZWSP filler)
          const text = (node.textContent ?? '').replace(new RegExp(ZWSP, 'g'), '');
          if (text.trim() === '' && node.childCount <= 1) {
            // Bare marker, no trailing space → matches the on-disk orphan form.
            state.write(check);
            state.closeBlock(node);
            return;
          }
          state.write(`${check} `);
          state.renderContent(node);
        },
        // Parse is inherited from the default taskItem spec (updateDOM hook).
      },
    };
  },
});
