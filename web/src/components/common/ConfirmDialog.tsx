import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';

interface ConfirmDialogProps {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  /** Omitted for alert-style dialogs (single OK button). */
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The app's own confirm/alert dialog — replaces browser-native `confirm`/`alert`
 * (rendered by useConfirm's ConfirmProvider). Portal to body, Esc-to-cancel +
 * scroll-lock via useModalOverlay, Enter confirms. Reuses the modal-overlay
 * styling conventions (.app-modal-*).
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useModalOverlay(onCancel);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the confirm button on mount so Enter works immediately + it's obvious.
  useEffect(() => {
    const t = setTimeout(() => confirmRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  return createPortal(
    <div
      className="app-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={onCancel}
    >
      <div className="app-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">{title}</div>
        {message != null && message !== '' && (
          <div className="app-modal-message">{message}</div>
        )}
        <div className="app-modal-actions">
          {cancelLabel && (
            <button className="app-modal-btn" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            className={`app-modal-btn primary${danger ? ' danger' : ''}`}
            onClick={onConfirm}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirm(); } }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
