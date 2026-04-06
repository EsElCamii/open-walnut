/**
 * File utility functions — findSimilarFile, path helpers.
 *
 * Ported from Claude Code's src/utils/file.ts (findSimilarFile at line 178).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Find files with the same base name but different extension in the same directory.
 * Used to suggest corrections when a file is not found (e.g. "foo.js" → "foo.ts").
 *
 * @returns The full path of the first similar file, or undefined.
 */
export function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const entryBase = path.basename(entry.name, path.extname(entry.name));
      const entryFull = path.join(dir, entry.name);
      if (entryBase === base && entryFull !== filePath) {
        return entryFull;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
