/**
 * One-time migration: ~/.open-walnut/global-notes.md → ~/.open-walnut/notes/global.md
 * Runs at server startup. Idempotent — skips if already migrated.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { GLOBAL_NOTES_FILE, NOTES_DIR } from '../constants.js'
import { log } from '../logging/index.js'

export async function migrateGlobalNotes(): Promise<void> {
  const targetFile = path.join(NOTES_DIR, 'global.md')

  try {
    // Check if old file exists
    await fsp.stat(GLOBAL_NOTES_FILE)
  } catch {
    // Old file doesn't exist — nothing to migrate
    return
  }

  try {
    // Check if target already exists
    await fsp.stat(targetFile)
    // Target exists — migration already done or user created it manually
    return
  } catch {
    // Target doesn't exist — proceed with migration
  }

  try {
    await fsp.mkdir(NOTES_DIR, { recursive: true })
    const content = await fsp.readFile(GLOBAL_NOTES_FILE, 'utf-8')
    await fsp.writeFile(targetFile, content, 'utf-8')
    // The old global-notes.md is intentionally left in place as a backup.
    // It is not deleted so that users who downgrade can still access their data.
    log.memory.info('Migrated global-notes.md → notes/global.md')
  } catch (err) {
    log.memory.error('Failed to migrate global notes', { error: String(err) })
  }
}
