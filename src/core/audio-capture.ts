/**
 * Audio Capture Service — record system/app audio, auto-chunk, store as WAV.
 *
 * Uses ScreenCaptureKit (via screencapturekit-audio-capture npm) on macOS 13+.
 * Gracefully degrades to unavailable on non-macOS platforms.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { RECORDINGS_DIR } from '../constants.js'
import { bus, EventNames } from './event-bus.js'
import { log } from '../logging/index.js'

// Native addons (.node files) can only be loaded via require(), not ESM import().
// Since tsup bundles as ESM, we create a require function for loading the native addon.
const require = createRequire(import.meta.url)

// ── Types ──

export type AudioSource = 'system' | 'mic' | 'both'
export type RecordingMode = 'continuous' | 'on-demand'

export interface RecordingOptions {
  source: AudioSource
  mode: RecordingMode
  /** Bundle IDs or app names to capture (system audio only) */
  apps?: string[]
  /** Chunk duration in minutes (default: 10) */
  chunkMinutes?: number
  /** Audio sample rate (default: 48000) */
  sampleRate?: number
  /** Audio channels (default: 1 for mono — saves space, good for voice) */
  channels?: 1 | 2
}

export interface RecordingStatus {
  recording: boolean
  recordingId: string | null
  source: AudioSource | null
  mode: RecordingMode | null
  apps: string[]
  startedAt: string | null
  currentChunkIndex: number
  currentChunkDuration: number
  totalDuration: number
}

export interface RecordingChunkMeta {
  recordingId: string
  chunkIndex: number
  date: string
  time: string
  filePath: string
  duration: number
  size: number
  source: AudioSource
  apps: string[]
  sampleRate: number
  channels: number
}

export interface RecordingListEntry {
  date: string
  files: Array<{
    name: string
    size: number
    meta?: RecordingChunkMeta
  }>
}

// ── Constants ──

const DEFAULT_CHUNK_MINUTES = 10
const DEFAULT_SAMPLE_RATE = 48000
const DEFAULT_CHANNELS = 1
const WAV_FORMAT_PCM = 1

// ── Service ──

class AudioCaptureService {
  private capture: any = null // AudioCapture instance (lazy-loaded)
  private recording = false
  private recordingId: string | null = null
  private source: AudioSource | null = null
  private mode: RecordingMode | null = null
  private apps: string[] = []
  private startedAt: number = 0
  private chunkStartedAt: number = 0
  private chunkIndex = 0
  private chunkTimer: ReturnType<typeof setTimeout> | null = null
  private audioBuffers: Buffer[] = []
  private totalSamples = 0
  private sampleRate = DEFAULT_SAMPLE_RATE
  private channels: 1 | 2 = DEFAULT_CHANNELS
  private chunkMinutes = DEFAULT_CHUNK_MINUTES
  private available: boolean | null = null // null = not checked yet

  /**
   * Check if audio capture is available on this platform.
   */
  isAvailable(): boolean {
    if (this.available !== null) return this.available
    try {
      if (process.platform !== 'darwin') {
        this.available = false
        return false
      }
      // Try loading the native addon
      require('screencapturekit-audio-capture')
      this.available = true
    } catch {
      this.available = false
    }
    return this.available
  }

  /**
   * Check screen recording permissions (macOS).
   */
  checkPermissions(): { granted: boolean; message: string } {
    if (!this.isAvailable()) {
      return { granted: false, message: 'Audio capture not available on this platform' }
    }
    try {
      const { AudioCapture } = require('screencapturekit-audio-capture')
      const status = AudioCapture.verifyPermissions()
      return { granted: status.granted, message: status.message }
    } catch (err) {
      return { granted: false, message: (err as Error).message }
    }
  }

  /**
   * List running applications that can be captured.
   */
  listApps(): Array<{ processId: number; bundleIdentifier: string; applicationName: string }> {
    if (!this.isAvailable()) return []
    try {
      const { AudioCapture } = require('screencapturekit-audio-capture')
      const ac = new AudioCapture()
      try {
        return ac.getAudioApps()
      } finally {
        ac.dispose()
      }
    } catch (err) {
      log.audio.error('listApps failed', { error: (err as Error).message })
      return []
    }
  }

  /**
   * Start recording audio.
   */
  async start(options: RecordingOptions): Promise<{ recordingId: string }> {
    if (this.recording) {
      throw new Error('Already recording. Stop current recording first.')
    }
    if (!this.isAvailable()) {
      throw new Error('Audio capture not available. macOS 13+ with Screen Recording permission required.')
    }

    const { AudioCapture } = require('screencapturekit-audio-capture')

    this.recordingId = randomBytes(6).toString('hex')
    this.source = options.source
    this.mode = options.mode
    this.apps = options.apps ?? []
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE
    this.channels = options.channels ?? DEFAULT_CHANNELS
    this.chunkMinutes = options.chunkMinutes ?? DEFAULT_CHUNK_MINUTES
    this.chunkIndex = 0
    this.audioBuffers = []
    this.totalSamples = 0
    this.startedAt = Date.now()
    this.chunkStartedAt = Date.now()

    // Ensure recordings directory exists
    const dateDir = this.getDateDir()
    fs.mkdirSync(dateDir, { recursive: true })

    // Create capture instance
    this.capture = new AudioCapture()

    // Set up audio event handler
    this.capture.on('audio', (sample: { data: Buffer; sampleRate: number; channels: number }) => {
      if (!this.recording) return
      this.audioBuffers.push(Buffer.from(sample.data))
      this.totalSamples += sample.data.length / (4 * this.channels) // float32 = 4 bytes per sample per channel
    })

    this.capture.on('error', (err: Error) => {
      log.audio.error('capture error', { recordingId: this.recordingId, error: err.message })
      bus.emit(EventNames.AUDIO_ERROR, {
        recordingId: this.recordingId ?? undefined,
        error: err.message,
      }, ['*'], { source: 'audio-capture' })
      // Auto-stop on stream error (e.g. ScreenCaptureKit connection interrupted)
      if (this.recording) {
        log.audio.warn('auto-stopping due to capture error')
        this.stop().catch(() => { /* already cleaning up */ })
      }
    })

    // Start capture — use high-level startCapture for per-app, captureDisplay for all system audio
    const captureOpts = {
      sampleRate: this.sampleRate,
      channels: this.channels,
      format: 'float32' as const,
    }
    try {
      if (options.source === 'system' && this.apps.length > 0) {
        // Per-app: use startCapture with smart app lookup
        this.capture.startCapture(this.apps[0], captureOpts)
      } else {
        // All system audio: capture the first display
        const displays = this.capture.getDisplays()
        if (displays.length === 0) throw new Error('No displays found')
        this.capture.captureDisplay(displays[0].displayId, captureOpts)
      }
    } catch (err) {
      this.cleanup()
      throw err
    }

    this.recording = true

    // Set up auto-chunk timer for continuous mode
    if (this.mode === 'continuous') {
      this.scheduleChunkTimer()
    }

    log.audio.info('recording started', {
      recordingId: this.recordingId,
      source: this.source,
      mode: this.mode,
      apps: this.apps,
    })

    bus.emit(EventNames.AUDIO_STARTED, {
      recordingId: this.recordingId,
      source: this.source,
      apps: this.apps.length > 0 ? this.apps : undefined,
      startedAt: new Date(this.startedAt).toISOString(),
    }, ['*'], { source: 'audio-capture' })

    return { recordingId: this.recordingId }
  }

  /**
   * Stop recording and save the final chunk.
   */
  async stop(): Promise<{ recordingId: string; chunks: number; totalDuration: number }> {
    if (!this.recording || !this.recordingId) {
      throw new Error('Not currently recording.')
    }

    const recordingId = this.recordingId
    const totalDuration = (Date.now() - this.startedAt) / 1000

    // Save current chunk
    await this.saveCurrentChunk()

    // Stop capture
    if (this.capture) {
      try { this.capture.stopCapture() } catch { /* already stopped */ }
    }

    const chunks = this.chunkIndex

    this.cleanup()

    log.audio.info('recording stopped', { recordingId, chunks, totalDuration })

    bus.emit(EventNames.AUDIO_STOPPED, {
      recordingId,
      duration: totalDuration,
      chunks,
    }, ['*'], { source: 'audio-capture' })

    return { recordingId, chunks, totalDuration }
  }

  /**
   * Get current recording status.
   */
  getStatus(): RecordingStatus {
    const now = Date.now()
    return {
      recording: this.recording,
      recordingId: this.recordingId,
      source: this.source,
      mode: this.mode,
      apps: this.apps,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      currentChunkIndex: this.chunkIndex,
      currentChunkDuration: this.recording ? (now - this.chunkStartedAt) / 1000 : 0,
      totalDuration: this.recording ? (now - this.startedAt) / 1000 : 0,
    }
  }

  /**
   * List all recordings grouped by date.
   */
  async listRecordings(): Promise<RecordingListEntry[]> {
    try {
      if (!fs.existsSync(RECORDINGS_DIR)) return []
      const dates = fs.readdirSync(RECORDINGS_DIR)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()

      const entries: RecordingListEntry[] = []
      for (const date of dates) {
        const dateDir = path.join(RECORDINGS_DIR, date)
        const files = fs.readdirSync(dateDir)
          .filter(f => f.endsWith('.wav'))
          .sort()
          .reverse()
          .map(f => {
            const stat = fs.statSync(path.join(dateDir, f))
            const metaFile = path.join(dateDir, f.replace('.wav', '.json'))
            let meta: RecordingChunkMeta | undefined
            try {
              if (fs.existsSync(metaFile)) {
                meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
              }
            } catch { /* ignore */ }
            return { name: f, size: stat.size, meta }
          })
        if (files.length > 0) {
          entries.push({ date, files })
        }
      }
      return entries
    } catch (err) {
      log.audio.error('listRecordings failed', { error: (err as Error).message })
      return []
    }
  }

  // ── Private ──

  private scheduleChunkTimer(): void {
    if (this.chunkTimer) clearTimeout(this.chunkTimer)
    this.chunkTimer = setTimeout(async () => {
      if (!this.recording) return
      try {
        await this.saveCurrentChunk()
        this.chunkStartedAt = Date.now()
        this.audioBuffers = []
        this.totalSamples = 0
        this.scheduleChunkTimer()
      } catch (err) {
        log.audio.error('auto-chunk failed', { error: (err as Error).message })
      }
    }, this.chunkMinutes * 60 * 1000)
  }

  private async saveCurrentChunk(): Promise<void> {
    if (this.audioBuffers.length === 0) return

    const pcmData = Buffer.concat(this.audioBuffers)
    if (pcmData.length === 0) return

    const dateStr = this.formatDate(new Date(this.chunkStartedAt))
    const timeStr = this.formatTime(new Date(this.chunkStartedAt))
    const dateDir = path.join(RECORDINGS_DIR, dateStr)
    fs.mkdirSync(dateDir, { recursive: true })

    const wavPath = path.join(dateDir, `${timeStr}.wav`)
    const metaPath = path.join(dateDir, `${timeStr}.json`)

    // Convert float32 PCM to WAV
    const wavBuffer = this.createWav(pcmData)
    fs.writeFileSync(wavPath, wavBuffer)

    const duration = (Date.now() - this.chunkStartedAt) / 1000

    // Save metadata
    const meta: RecordingChunkMeta = {
      recordingId: this.recordingId!,
      chunkIndex: this.chunkIndex,
      date: dateStr,
      time: timeStr,
      filePath: wavPath,
      duration,
      size: wavBuffer.length,
      source: this.source!,
      apps: this.apps,
      sampleRate: this.sampleRate,
      channels: this.channels,
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    this.chunkIndex++

    log.audio.info('chunk saved', {
      recordingId: this.recordingId,
      chunkIndex: meta.chunkIndex,
      duration: Math.round(duration),
      size: wavBuffer.length,
      path: wavPath,
    })

    bus.emit(EventNames.AUDIO_CHUNK_SAVED, {
      recordingId: this.recordingId!,
      chunkIndex: meta.chunkIndex,
      filePath: wavPath,
      duration,
      size: wavBuffer.length,
    }, ['*'], { source: 'audio-capture' })
  }

  private createWav(pcmFloat32: Buffer): Buffer {
    // Convert float32 to int16 for smaller file size
    const numSamples = pcmFloat32.length / 4
    const int16Data = Buffer.alloc(numSamples * 2)
    for (let i = 0; i < numSamples; i++) {
      const float = pcmFloat32.readFloatLE(i * 4)
      const clamped = Math.max(-1, Math.min(1, float))
      int16Data.writeInt16LE(Math.round(clamped * 32767), i * 2)
    }

    const dataSize = int16Data.length
    const headerSize = 44
    const wav = Buffer.alloc(headerSize + dataSize)

    // RIFF header
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + dataSize, 4)
    wav.write('WAVE', 8)

    // fmt chunk
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16) // chunk size
    wav.writeUInt16LE(WAV_FORMAT_PCM, 20) // PCM format
    wav.writeUInt16LE(this.channels, 22)
    wav.writeUInt32LE(this.sampleRate, 24)
    wav.writeUInt32LE(this.sampleRate * this.channels * 2, 28) // byte rate (int16 = 2 bytes)
    wav.writeUInt16LE(this.channels * 2, 32) // block align
    wav.writeUInt16LE(16, 34) // bits per sample (int16)

    // data chunk
    wav.write('data', 36)
    wav.writeUInt32LE(dataSize, 40)
    int16Data.copy(wav, 44)

    return wav
  }

  private cleanup(): void {
    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer)
      this.chunkTimer = null
    }
    if (this.capture) {
      try { this.capture.dispose() } catch { /* ignore */ }
      this.capture = null
    }
    this.recording = false
    this.recordingId = null
    this.source = null
    this.mode = null
    this.apps = []
    this.audioBuffers = []
    this.totalSamples = 0
    this.startedAt = 0
    this.chunkStartedAt = 0
    this.chunkIndex = 0
  }

  private getDateDir(): string {
    return path.join(RECORDINGS_DIR, this.formatDate(new Date()))
  }

  private formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  private formatTime(d: Date): string {
    return `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`
  }
}

export const audioCaptureService = new AudioCaptureService()
