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
// Browser bug (esp. Firefox with a wedged capture process) yields a pure-zero stream
// (~ -91 dB). We detect that early so the user isn't left talking into a dead mic.
const SILENCE_RMS_THRESHOLD = 0.012; // below this = effectively silent
const SILENCE_GRACE_MS = 2200;       // allow this long to start producing sound

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
  const rafRef = useRef<number | undefined>(undefined);
  // True once we observed any non-silent audio this recording. Reset on each start.
  const sawSoundRef = useRef(false);
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
    if (rafRef.current !== undefined) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
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
      sawSoundRef.current = false;
      abortedSilentRef.current = false;
      analyserAttachedRef.current = false;
      try {
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyserRef.current = analyser;
          analyserAttachedRef.current = true;

          const buf = new Uint8Array(analyser.fftSize);
          const startedAt = performance.now();
          const tick = () => {
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
            if (rms >= SILENCE_RMS_THRESHOLD) sawSoundRef.current = true;
            // Smooth + amplify a bit for a lively meter display
            setLevel((prev) => prev * 0.6 + Math.min(1, rms * 3) * 0.4);

            // Early silence abort: grace period elapsed and never saw real sound →
            // the mic is feeding a dead/silent stream (classic Firefox wedge). Stop now.
            if (!sawSoundRef.current && performance.now() - startedAt > SILENCE_GRACE_MS) {
              abortedSilentRef.current = true;
              setError('No sound detected from the microphone. Check your mic device (or restart the browser) and try again.');
              const rec = mediaRecorderRef.current;
              if (rec && rec.state !== 'inactive') rec.stop();
              return; // stop the RAF loop; onstop will skip transcription
            }
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
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
        const sawSound = sawSoundRef.current;
        stopStream();
        setIsRecording(false);

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

        if (blob.size === 0) return;

        // Don't transcribe silence — Whisper hallucinates "you"/"thank you" on empty audio.
        // `abortedSilent` = auto-stopped mid-recording; `!sawSound` = user stopped but we
        // never observed real input (analyser ran the whole time and saw only silence).
        if (abortedSilent || (analyserAttachedRef.current && !sawSound)) {
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
