/**
 * QMD indexing wait utility.
 *
 * QMD indexing is async — after seeding files, tests must wait
 * for QMD to finish update() + embed() before querying.
 *
 * Strategy: After file writes, wait for the debounce period (2s for memory,
 * 5s for notes) plus a buffer, then verify by running a search.
 */

/**
 * Wait for QMD memory store indexing to settle.
 * The file watcher has a 2s debounce for memory files.
 * We wait longer than the debounce plus buffer for embed().
 */
export async function waitForQmdMemoryIndex(ms: number = 5000): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait for QMD notes store indexing to settle.
 * The file watcher has a 5s debounce for notes files.
 */
export async function waitForQmdNotesIndex(ms: number = 8000): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until a search query returns results, or timeout.
 * Useful for waiting on QMD indexing completion.
 */
export async function waitForSearchResults(
  searchFn: () => Promise<unknown[]>,
  options: { maxWaitMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const { maxWaitMs = 30000, pollIntervalMs = 1000 } = options;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const results = await searchFn();
      if (results.length > 0) return true;
    } catch {
      // QMD may not be ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return false;
}
