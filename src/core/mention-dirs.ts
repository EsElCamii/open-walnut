/**
 * Persistent store of folders the user browsed in the "@" file picker.
 *
 * Kept SEPARATE from the session-derived frequent-directories store on purpose:
 * the /session path picker should only suggest dirs that were actual session
 * working directories, NOT every folder someone clicked through in an "@" mention.
 * The "@?" recents search reads the UNION of this store + frequent-dirs; /session
 * reads only frequent-dirs. Data lives at ~/.open-walnut/mention-directories.json.
 */

import fs from 'node:fs'
import path from 'node:path'
import { MENTION_DIRS_FILE } from '../constants.js'
import { log } from '../logging/index.js'

// The "@" picker records every browsed folder, so cap the store (top-N by count,
// then recency) to keep the file and the client-side fuzzy match bounded.
const MAX_ENTRIES = 300

export interface MentionDirEntry {
  cwd: string
  host: string | null
  count: number
  lastUsed: string // ISO timestamp
}

interface MentionDirsStore {
  version: 1
  directories: MentionDirEntry[]
}

// In-process write lock (same pattern as frequent-dirs / session-tracker).
let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock
  let resolve: () => void
  writeLock = new Promise<void>(r => { resolve = r })
  return prev.then(fn).finally(() => resolve!())
}

function readStore(): MentionDirsStore {
  try {
    if (!fs.existsSync(MENTION_DIRS_FILE)) return { version: 1, directories: [] }
    const parsed = JSON.parse(fs.readFileSync(MENTION_DIRS_FILE, 'utf-8'))
    if (parsed?.version !== 1 || !Array.isArray(parsed?.directories)) return { version: 1, directories: [] }
    return parsed as MentionDirsStore
  } catch (err) {
    log.session.debug('mention-dirs: failed to read store', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { version: 1, directories: [] }
  }
}

function writeStore(store: MentionDirsStore): void {
  fs.mkdirSync(path.dirname(MENTION_DIRS_FILE), { recursive: true })
  fs.writeFileSync(MENTION_DIRS_FILE, JSON.stringify(store, null, 2))
}

/** All folders recorded from the "@" picker. */
export async function getMentionDirs(): Promise<MentionDirEntry[]> {
  return readStore().directories
}

/** Record a folder the user browsed/selected in the "@" picker. */
export async function recordMentionDir(cwd: string, host: string | null): Promise<void> {
  return withWriteLock(async () => {
    const store = readStore()
    const key = `${cwd}::${host ?? '__local__'}`
    const entry = store.directories.find(d => `${d.cwd}::${d.host ?? '__local__'}` === key)
    if (entry) {
      entry.count++
      entry.lastUsed = new Date().toISOString()
    } else {
      store.directories.push({ cwd, host, count: 1, lastUsed: new Date().toISOString() })
    }
    // Prune to top-N by frequency, then recency.
    if (store.directories.length > MAX_ENTRIES) {
      store.directories.sort((a, b) =>
        (b.count - a.count) ||
        (new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime()),
      )
      store.directories = store.directories.slice(0, MAX_ENTRIES)
    }
    writeStore(store)
  })
}
