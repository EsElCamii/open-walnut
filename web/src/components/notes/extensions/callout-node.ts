/**
 * Callout — block Node serialized as a `> [!kind]` admonition blockquote
 * (§3.3 of IMPL-CONTRACT). FROZEN kinds: note · tip · warning · danger · info.
 *
 * Disk form:
 *   > [!warning]
 *   > body line one
 *   > body line two
 *
 * Serialize: write `> [!kind]` then wrapBlock('> ', …) over the body so nested
 * blocks keep the `> ` prefix. Parse: markdown-it emits a normal <blockquote>;
 * `parse.updateDOM` re-tags any blockquote whose FIRST line is exactly
 * `[!kind]` (kind in the allow-set) into a callout <div> and drops that marker
 * line. A plain blockquote (no `[!…]`) stays a blockquote.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CALLOUT_KINDS } from '../block-transforms';
import type { CalloutKind } from '../block-transforms';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { kind?: CalloutKind }) => ReturnType;
      toggleCallout: (attrs?: { kind?: CalloutKind }) => ReturnType;
    };
  }
}

const KIND_SET = new Set<string>(CALLOUT_KINDS);

function normalizeKind(raw: string | null | undefined): CalloutKind {
  const k = (raw || '').toLowerCase();
  return (KIND_SET.has(k) ? k : 'note') as CalloutKind;
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: el => normalizeKind((el as HTMLElement).getAttribute('data-callout')),
        renderHTML: attrs => ({ 'data-callout': attrs.kind }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = node.attrs.kind;
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: `notes-callout notes-callout-${kind}` }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout: (attrs) => ({ commands }) =>
        commands.wrapIn(this.name, { kind: normalizeKind(attrs?.kind) }),
      toggleCallout: (attrs) => ({ commands }) =>
        commands.toggleWrap(this.name, { kind: normalizeKind(attrs?.kind) }),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          const kind = normalizeKind((node.attrs as { kind?: string }).kind);
          // Marker line, then the body wrapped with the blockquote prefix.
          state.write(`> [!${kind}]`);
          state.ensureNewLine();
          (state as any).wrapBlock('> ', null, node, () => state.renderContent(node));
        },
        parse: {
          // markdown-it produces a <blockquote>; re-tag the admonition ones.
          updateDOM(element: HTMLElement) {
            element.querySelectorAll('blockquote').forEach(bq => {
              const firstP = bq.querySelector('p');
              if (!firstP) return;
              const text = firstP.textContent ?? '';
              // markdown-it folds all blockquote lines into one <p> joined by
              // '\n', so the marker is the FIRST line and the body is everything
              // after it. `[\s\S]*` (not `.*`) keeps every subsequent line — a
              // bare `.*` both fails to match a 3+ line callout (no `s` flag → it
              // can't reach `$`) and silently drops body lines past the first.
              const m = /^\s*\[!([A-Za-z]+)\][ \t]*\n?([\s\S]*)$/.exec(text);
              if (!m) return;
              const kind = m[1].toLowerCase();
              if (!KIND_SET.has(kind)) return; // unknown kind → stays a blockquote

              const div = element.ownerDocument.createElement('div');
              div.setAttribute('data-callout', kind);

              // Drop the marker from the first paragraph; keep any trailing text
              // that shared the marker line (e.g. `> [!tip] inline body`).
              const trailing = m[2];
              if (trailing) {
                firstP.textContent = trailing;
              } else {
                firstP.remove();
              }
              while (bq.firstChild) div.appendChild(bq.firstChild);
              // If everything got removed, give the callout an empty paragraph.
              if (!div.querySelector('p')) {
                div.appendChild(element.ownerDocument.createElement('p'));
              }
              bq.replaceWith(div);
            });
          },
        },
      },
    };
  },
});
