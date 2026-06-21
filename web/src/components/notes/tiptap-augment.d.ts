/**
 * TipTap type augmentations for the notes editor.
 *
 * Two gaps the installed packages don't type against web's @tiptap/core@3.26.0:
 *
 * 1. `editor.storage.markdown` — `tiptap-markdown` exports a `MarkdownStorage`
 *    type but never augments core's (empty, open) `Storage` interface, so
 *    `editor.storage.markdown.getMarkdown()` is untyped. Declared here.
 *
 * 2. `setImage` — `@tiptap/extension-image` is resolved from the hoisted root
 *    (3.20.1) whose `Commands` augmentation targets a *different* core instance
 *    than web's 3.26.0, so the `image.setImage` command doesn't land on the
 *    3.26.0 `ChainedCommands`. Re-declare it against web's core here.
 *
 * Additive only — no runtime impact. Lives in the notes folder (owned).
 */
import '@tiptap/core';

declare module '@tiptap/core' {
  interface Storage {
    markdown: {
      getMarkdown(): string;
      options: Record<string, unknown>;
    };
  }

  interface Commands<ReturnType> {
    image: {
      /** Insert an image node. */
      setImage: (options: { src: string; alt?: string; title?: string }) => ReturnType;
    };
  }
}
