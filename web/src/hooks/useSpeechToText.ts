/**
 * React hook for browser-based speech-to-text.
 *
 * Uses MediaRecorder to capture mic audio, then sends to the server
 * for transcription via the configured STT engine.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { transcribeAudio } from '@/api/stt';
import { log } from '@/utils/log';

export interface UseSpeechToTextOptions {
  /** Called with transcribed text when transcription completes */
  onTranscribe: (text: string) => void;
  /** ISO 639-1 language hint */
  language?: string;
}

export interface UseSpeechToTextReturn {
  /** Whether the browser supports MediaRecorder */
  isSupported: boolean;
  /** Currently recording */
  isRecording: boolean;
  /** Waiting for server transcription response */
  isTranscribing: boolean;
  /** Error message (cleared on next toggle) */
  error: string | null;
  /** Start or stop recording */
  toggleRecording: () => void;
  /** Re-transcribe the last recording with a different model (one-shot whisper-cli) */
  retryWithModel: (model: string) => Promise<void>;
  /** Debug audio file path from the last transcription (server-side) */
  lastDebugPath: string | null;
  /** Whether we have a last recording available for retry */
  hasLastRecording: boolean;
  /** Live mic input level 0..1 (smoothed RMS) while recording — drives the waveform UI */
  level: number;
}

// Mic-silence detection tunables.
// We only abort on a DEAD stream — a wedged browser capture (esp. Firefox) emits pure
// zero samples (~ -91 dB). We deliberately do NOT abort on "quiet" or "hasn't spoken
// yet": a real mic always has a noise floor (~ -50..-60 dB) even during a pause, so a
// user who thinks before speaking must never be cut off. The dead-stream floor below
// (~ -62 dB) sits cleanly between the two.
const DEAD_STREAM_RMS = 0.0008;      // RMS at/below this for the whole grace = dead mic
// Grace counted in *sampled ticks*, not wall-clock: a backgrounded/blurred tab can
// pause our sampler, and wall-clock would then expire while we captured nothing — which
// false-fired the abort the instant the tab refocused. Ticks only advance while we are
// actually sampling audio.
const SAMPLE_INTERVAL_MS = 100;      // how often we sample RMS
const SILENCE_GRACE_TICKS = 25;      // ~2.5s of actual sampling before declaring dead

const isMediaRecorderSupported =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

export function useSpeechToText({ onTranscribe, language }: UseSpeechToTextOptions): UseSpeechToTextReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDebugPath, setLastDebugPath] = useState<string | null>(null);
  const [hasLastRecording, setHasLastRecording] = useState(false);
  const [level, setLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Web Audio analyser for live level + early silence detection
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // setInterval (NOT requestAnimationFrame) drives sampling — rAF is throttled/paused
  // when the tab is backgrounded or blurred, which previously broke silence detection.
  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // True once the signal rose above the dead-stream floor (incl. a live mic's noise
  // floor). Distinguishes a truly dead stream from a quiet/short real recording so the
  // onstop backstop never drops genuine audio. Reset on each start.
  const sawAnyNonDeadRef = useRef(false);
  // Set when we abort a recording due to silence, so onstop knows to skip transcription.
  const abortedSilentRef = useRef(false);
  // True when the analyser successfully attached this recording (so the silence
  // backstop in onstop only applies when we actually had working level data).
  const analyserAttachedRef = useRef(false);
  // Keep last audio for retry
  const lastAudioRef = useRef<{ base64: string; format: string } | null>(null);
  // Refs mirror props to avoid stale closures in MediaRecorder.onstop async callback
  const onTranscribeRef = useRef(onTranscribe);
  onTranscribeRef.current = onTranscribe;
  const languageRef = useRef(language);
  languageRef.current = language;
  const isMountedRef = useRef(true);
  // Reset on every mount, not just set-false on unmount: this component can be
  // unmounted+remounted while a recording's async onstop is still pending (parent
  // re-renders the chat input). A one-shot cleanup would leave isMounted=false
  // forever, silently dropping the transcription. Re-arm it on each mount.
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const stopStream = useCallback(() => {
    if (sampleTimerRef.current !== undefined) {
      clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = undefined;
    }
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setLevel(0);
  }, []);

  const toggleRecording = useCallback(async () => {
    setError(null);

    // Stop recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      return;
    }

    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 16000 } },
      });
      streamRef.current = stream;

      // Set up Web Audio analyser for live level + early silence detection.
      // Best-effort: if AudioContext is unavailable, recording still works (just no waveform).
      sawAnyNonDeadRef.current = false;
      abortedSilentRef.current = false;
      analyserAttachedRef.current = false;
      try {
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioCtxRef.current = ctx;
          // An AudioContext can start `suspended` (no user-gesture autoplay). A suspended
          // context feeds the analyser flat silence → sawSound never latches → false abort.
          // resume() is best-effort; the toggle click is itself the gesture.
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyserRef.current = analyser;
          analyserAttachedRef.current = true;

          const buf = new Uint8Array(analyser.fftSize);
          let sampledTicks = 0;          // ticks that actually ran (background-tab safe)

          // setInterval, not rAF: rAF pauses when the tab is backgrounded/blurred. With the
          // old wall-clock grace, refocusing fired the abort instantly even though the user
          // had been speaking. Counting ticks ties the grace to real sampling progress.
          sampleTimerRef.current = setInterval(() => {
            const a = analyserRef.current;
            if (!a) return;
            a.getByteTimeDomainData(buf);
            // RMS around the 128 center (silence == flat 128)
            let sumSq = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128;
              sumSq += v * v;
            }
            const rms = Math.sqrt(sumSq / buf.length);
            if (rms > DEAD_STREAM_RMS) sawAnyNonDeadRef.current = true;  // even noise floor counts as "alive"
            // Smooth + amplify a bit for a lively meter display
            setLevel((prev) => prev * 0.6 + Math.min(1, rms * 3) * 0.4);
            sampledTicks++;

            // Abort ONLY on a dead stream: sampled long enough and the signal never once
            // rose above the dead floor (pure-zero). A live mic's noise floor clears this
            // even if the user hasn't spoken yet, so a thinking pause is never cut off.
            if (!sawAnyNonDeadRef.current && sampledTicks >= SILENCE_GRACE_TICKS) {
              abortedSilentRef.current = true;
              setError('No sound detected from the microphone. Check your mic device (or restart the browser) and try again.');
              const rec = mediaRecorderRef.current;
              if (rec && rec.state !== 'inactive') rec.stop();
            }
          }, SAMPLE_INTERVAL_MS);
        }
      } catch {
        // Analyser is best-effort; ignore and record without level/silence detection.
      }

      // Prefer webm/opus, fall back to whatever is available
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const abortedSilent = abortedSilentRef.current;
        const deadStream = analyserAttachedRef.current && !sawAnyNonDeadRef.current;
        stopStream();
        setIsRecording(false);

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

        if (blob.size === 0) return;

        // Don't transcribe a DEAD stream — Whisper hallucinates "you"/"thank you" on pure
        // silence. `abortedSilent` = auto-stopped mid-recording; `deadStream` = user stopped
        // but the analyser never saw the signal rise above the dead-stream floor (pure-zero).
        // We gate on the dead floor, NOT on whether real speech was detected, so a quiet or
        // very short genuine recording is still transcribed.
        if (abortedSilent || deadStream) {
          if (!abortedSilent && isMountedRef.current) {
            setError('No sound detected from the microphone. Check your mic device (or restart the browser) and try again.');
          }
          return;
        }

        // Convert blob to base64 using FileReader (avoids stack overflow on large audio)
        if (!isMountedRef.current) return;
        setIsTranscribing(true);
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const dataUrl = reader.result as string;
              resolve(dataUrl.split(',')[1] ?? '');
            };
            reader.onerror = () => reject(new Error('Failed to read audio blob'));
            reader.readAsDataURL(blob);
          });

          // Determine format from mime type (Safari uses audio/mp4)
          const mime = recorder.mimeType;
          const format = mime.includes('webm') ? 'webm'
            : mime.includes('mp4') ? 'mp4'
            : mime.includes('ogg') ? 'ogg'
            : 'webm'; // fallback

          log.info('stt', `Sending ${(blob.size / 1024).toFixed(1)}KB ${format} for transcription`);

          // Save for retry
          lastAudioRef.current = { base64, format };
          if (isMountedRef.current) setHasLastRecording(true);

          const result = await transcribeAudio(base64, format, languageRef.current);

          if (isMountedRef.current && result.debugAudioPath) {
            setLastDebugPath(result.debugAudioPath);
          }

          if (result.text) {
            if (!isMountedRef.current) return;
            onTranscribeRef.current(result.text);
            const preview = result.text.length > 50 ? result.text.slice(0, 50) + '...' : result.text;
            log.info('stt', `Transcribed: "${preview}" (${result.durationMs}ms)`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('stt', `Transcription failed: ${msg}`);
          if (!isMountedRef.current) return;
          setError(msg);
        } finally {
          if (isMountedRef.current) setIsTranscribing(false);
        }
      };

      recorder.onerror = (e: Event) => {
        stopStream();
        setIsRecording(false);
        const errMsg = (e as MediaRecorderErrorEvent)?.error?.message ?? 'Recording error';
        setError(errMsg);
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      stopStream();
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        setError('Microphone permission denied');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    }
  }, [stopStream]);

  const retryWithModel = useCallback(async (model: string) => {
    const last = lastAudioRef.current;
    if (!last) return;

    setError(null);
    setIsTranscribing(true);
    try {
      log.info('stt', `Retrying transcription with model: ${model}`);
      const result = await transcribeAudio(last.base64, last.format, languageRef.current, model);

      if (isMountedRef.current && result.debugAudioPath) {
        setLastDebugPath(result.debugAudioPath);
      }

      if (result.text && isMountedRef.current) {
        onTranscribeRef.current(result.text);
        const preview = result.text.length > 50 ? result.text.slice(0, 50) + '...' : result.text;
        log.info('stt', `Retry transcribed: "${preview}" (${result.durationMs}ms, model=${model})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('stt', `Retry failed: ${msg}`);
      if (isMountedRef.current) setError(msg);
    } finally {
      if (isMountedRef.current) setIsTranscribing(false);
    }
  }, []);

  return {
    isSupported: isMediaRecorderSupported,
    isRecording,
    isTranscribing,
    error,
    toggleRecording,
    retryWithModel,
    lastDebugPath,
    hasLastRecording,
    level,
  };
}
