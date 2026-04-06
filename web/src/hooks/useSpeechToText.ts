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
}

const isMediaRecorderSupported =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

export function useSpeechToText({ onTranscribe, language }: UseSpeechToTextOptions): UseSpeechToTextReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Refs mirror props to avoid stale closures in MediaRecorder.onstop async callback
  const onTranscribeRef = useRef(onTranscribe);
  onTranscribeRef.current = onTranscribe;
  const languageRef = useRef(language);
  languageRef.current = language;
  const isMountedRef = useRef(true);
  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

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
        stopStream();
        setIsRecording(false);

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

        if (blob.size === 0) return;

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
          const result = await transcribeAudio(base64, format, languageRef.current);

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

  return {
    isSupported: isMediaRecorderSupported,
    isRecording,
    isTranscribing,
    error,
    toggleRecording,
  };
}
