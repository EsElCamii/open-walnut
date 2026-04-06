import { useAudioCapture } from '@/hooks/useAudioCapture';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function RecordingButton() {
  const { available, recording, totalDuration, loading, toggleRecording } = useAudioCapture();

  // Don't render if audio capture is not available
  if (available === false) return null;
  // Still loading availability check
  if (available === null) return null;

  return (
    <button
      className={`recording-btn ${recording ? 'recording-btn--active' : ''}`}
      onClick={toggleRecording}
      disabled={loading}
      title={recording ? 'Stop recording' : 'Start recording system audio'}
      aria-label={recording ? 'Stop recording' : 'Start recording'}
    >
      <span className="recording-btn__dot" />
      {recording && (
        <span className="recording-btn__duration">{formatDuration(totalDuration)}</span>
      )}
    </button>
  );
}
