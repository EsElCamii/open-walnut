import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

/**
 * App-wide confirm/alert dialogs — replacing the browser-native `window.confirm`
 * / `window.alert` (ugly, un-themeable, and on localhost showed a "don't allow
 * this site to prompt you again" checkbox). One `<ConfirmProvider>` mounts a
 * single portal dialog; `useConfirm()` / `useAlert()` return promise-based APIs:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Delete "foo.md"?', danger: true })) { ... }
 *
 *   const alert = useAlert();
 *   await alert({ title: 'Save failed', message: err.message });
 */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

interface AlertOptions {
  title: string;
  message?: ReactNode;
  okLabel?: string;
}

type DialogState =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'alert'; opts: AlertOptions; resolve: () => void }
  | null;

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  // Keep the latest resolver reachable from the dialog callbacks without stale closures.
  const stateRef = useRef<DialogState>(null);
  stateRef.current = state;

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ kind: 'confirm', opts, resolve });
    });
  }, []);

  const alert = useCallback((opts: AlertOptions) => {
    return new Promise<void>((resolve) => {
      setState({ kind: 'alert', opts, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    const s = stateRef.current;
    setState(null);
    if (s?.kind === 'confirm') s.resolve(true);
    else if (s?.kind === 'alert') s.resolve();
  }, []);

  const handleCancel = useCallback(() => {
    const s = stateRef.current;
    setState(null);
    if (s?.kind === 'confirm') s.resolve(false);
    else if (s?.kind === 'alert') s.resolve();
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      {state && (
        <ConfirmDialog
          title={state.opts.title}
          message={state.opts.message}
          confirmLabel={
            state.kind === 'alert'
              ? (state.opts.okLabel ?? 'OK')
              : (state.opts.confirmLabel ?? 'Confirm')
          }
          cancelLabel={state.kind === 'confirm' ? (state.opts.cancelLabel ?? 'Cancel') : undefined}
          danger={state.kind === 'confirm' && !!state.opts.danger}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmContext.Provider>
  );
}

function useConfirmContext(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // Fallback to native dialogs if a consumer is mounted outside the provider
    // (shouldn't happen — provider wraps the whole app + popouts).
    return {
      // eslint-disable-next-line no-alert
      confirm: async (opts) => window.confirm(opts.title),
      // eslint-disable-next-line no-alert
      alert: async (opts) => window.alert(opts.title),
    };
  }
  return ctx;
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useConfirmContext().confirm;
}

export function useAlert(): (opts: AlertOptions) => Promise<void> {
  return useConfirmContext().alert;
}
