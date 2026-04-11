/**
 * Recording Reaper — periodic cleanup of old recording files.
 *
 * Two cleanup strategies:
 *   1. Date-based: delete entire date directories older than retention_days (default: 7)
 *   2. Orphan WAV: delete WAV files older than 24h that were never transcribed
 *      (no .txt file alongside them — catches recordings when no STT engine was configured)
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { RECORDINGS_DIR } from '../constants.js'
import { getConfig } from './config-manager.js'
import { log } from '../logging/index.js'

const REAP_INTERVAL_MS = 60 * 60 * 1000   // every hour
const INITIAL_DELAY_MS = 2 * 60 * 1000    // 2 minutes after server start
const DEFAULT_RETENTION_DAYS = 7
// WAVs without a .txt file after 24h were recorded when no STT engine was
// configured and will likely never be transcribed.
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

class RecordingReaper {
  private timer: ReturnType<typeof setInterval> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null

  start(): void {
    if (this.timer) return
    this.initialTimer = setTimeout(() => {
      this.reap().catch((err) => {
        log.audio.warn('recording reaper: unexpected error', { error: String(err) })
      })
      this.initialTimer = null
    }, INITIAL_DELAY_MS)
    this.timer = setInterval(() => this.reap().catch((err) => {
      log.audio.warn('recording reaper: unexpected error', { error: String(err) })
    }), REAP_INTERVAL_MS)
    log.audio.info('recording reaper started', { intervalMs: REAP_INTERVAL_MS })
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      log.audio.info('recording reaper stopped')
    }
  }

  async reap(): Promise<{ deletedDirs: number; deletedOrphans: number }> {
    let retentionDays = DEFAULT_RETENTION_DAYS
    try {
      const config = await getConfig()
      retentionDays = config.audio?.retention_days ?? DEFAULT_RETENTION_DAYS
    } catch { /* use default */ }

    // retention_days=0 means "keep forever" — skip all cleanup
    if (retentionDays === 0) return { deletedDirs: 0, deletedOrphans: 0 }

    let deletedDirs = 0
    let deletedOrphans = 0

    // Check if recordings directory exists
    try {
      await fs.access(RECORDINGS_DIR)
    } catch {
      return { deletedDirs: 0, deletedOrphans: 0 }
    }

    const now = Date.now()
    let dateDirs: string[]
    try {
      dateDirs = (await fs.readdir(RECORDINGS_DIR))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    } catch {
      return { deletedDirs: 0, deletedOrphans: 0 }
    }

    for (const dateStr of dateDirs) {
      const dateDir = path.join(RECORDINGS_DIR, dateStr)

      // Strategy 1: Date-based cleanup (if retention_days > 0)
      if (retentionDays > 0) {
        const dirDate = new Date(dateStr)
        if (!isNaN(dirDate.getTime())) {
          const ageMs = now - dirDate.getTime()
          if (ageMs > retentionDays * 24 * 60 * 60 * 1000) {
            try {
              await fs.rm(dateDir, { recursive: true, force: true })
              deletedDirs++
              log.audio.info('recording reaper: deleted old date dir', { dateStr, ageDays: Math.floor(ageMs / 86400000) })
            } catch (err) {
              log.audio.warn('recording reaper: failed to delete date dir', { dateStr, error: (err as Error).message })
            }
            continue // dir deleted, skip orphan check
          }
        }
      }

      // Strategy 2: Orphan WAV cleanup within non-expired dirs
      try {
        const files = await fs.readdir(dateDir)
        const wavFiles = files.filter(f => f.endsWith('.wav'))

        for (const wavFile of wavFiles) {
          const wavPath = path.join(dateDir, wavFile)
          const txtFile = wavFile.replace(/\.wav$/, '.txt')

          // If .txt exists, transcription happened — WAV should have been deleted by transcriber
          // (unless delete_after_transcription is disabled). Either way, not an orphan.
          // Coupled to audio-transcriber.ts which always writes .txt (even for empty
          // transcriptions). If that behavior changes, this orphan detection will break.
          if (files.includes(txtFile)) continue

          // Check WAV age
          try {
            const wavStat = await fs.stat(wavPath)
            if (now - wavStat.mtimeMs > ORPHAN_AGE_MS) {
              await fs.unlink(wavPath)
              deletedOrphans++
              log.audio.info('recording reaper: deleted orphan WAV', {
                path: wavPath,
                ageHours: Math.floor((now - wavStat.mtimeMs) / 3600000),
              })
            }
          } catch { /* stat/unlink failed — skip */ }
        }

        // Clean up empty date directories
        try {
          const remaining = await fs.readdir(dateDir)
          if (remaining.length === 0) {
            await fs.rmdir(dateDir)
            log.audio.debug('recording reaper: removed empty date dir', { dateStr })
          }
        } catch { /* ignore */ }
      } catch { /* readdir failed — skip */ }
    }

    if (deletedDirs > 0 || deletedOrphans > 0) {
      log.audio.info('recording reaper: cleanup complete', { deletedDirs, deletedOrphans })
    }

    return { deletedDirs, deletedOrphans }
  }
}

export const recordingReaper = new RecordingReaper()
