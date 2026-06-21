import { fetchNoteContent, saveNoteContent } from '@/api/notes-v2';
import type { RawFlushIO } from './MarkdownEditorPanel';

/**
 * Frontmatter-preserving raw-flush IO for vault notes (notes-v2 API). Used by the
 * raw-markdown toggle's cold-start fallback in any surface that edits a vault .md
 * file (NotesEditorPanel, PopoutNote).
 */
export const VAULT_RAW_IO: RawFlushIO = {
  read: async (path) => {
    const { content, contentHash } = await fetchNoteContent(path);
    return { content, contentHash };
  },
  save: (path, content, contentHash) => saveNoteContent(path, content, contentHash),
  splitFrontmatter: true,
};
