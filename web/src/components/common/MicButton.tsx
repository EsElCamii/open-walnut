/**
 * Microphone button for speech-to-text input.
 *
 * States: idle (gray) → recording (red pulse) → transcribing (spinner)
 * Gracefully hidden when MediaRecorder is not supported.
 */

import { useSpeechToText } from '@/hooks/useSpeechToText';

interface MicButtonProps {
  /** Called with transcribed text */
  onTranscribe: (text: string) => void;
  /** ISO 639-1 language hint */
  language?: string;
  /** Disable the button */
  disabled?: boolean;
  /** Button size */
  size?: 'sm' | 'md';
}

export function MicButton({ onTranscribe, language, disabled, size = 'md' }: MicButtonProps) {
  const { isSupported, isRecording, isTranscribing, error, toggleRecording } = useSpeechToText({
    onTranscribe,
    language,
  });

  if (!isSupported) return null;

  const className = [
    'btn mic-btn',
    size === 'sm' && 'mic-btn-sm',
    isRecording && 'mic-recording',
    isTranscribing && 'mic-transcribing',
  ].filter(Boolean).join(' ');

  const title = error
    ? `Error: ${error}`
    : isTranscribing
      ? 'Transcribing...'
      : isRecording
        ? 'Stop recording'
        : 'Voice input';

  return (
    <button
      className={className}
      onClick={toggleRecording}
      type="button"
      disabled={disabled || isTranscribing}
      aria-label={title}
      title={title}
    >
      {isTranscribing ? (
        <svg className="mic-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="1" width="6" height="12" rx="3" />
          <path d="M19 10v2a7 7 0 01-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  );
}
