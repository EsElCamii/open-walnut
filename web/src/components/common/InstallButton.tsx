import { useState, useCallback } from 'react';
import { installDependency, type InstallTarget } from '@/api/system';

interface InstallButtonProps {
  target: InstallTarget;
  label?: string;
  className?: string;
}

type State = 'idle' | 'installing' | 'success' | 'error';

export function InstallButton({ target, label = 'Install', className = '' }: InstallButtonProps) {
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleClick = useCallback(async () => {
    setState('installing');
    setErrorMsg('');
    const result = await installDependency(target);
    if (result.ok) {
      setState('success');
    } else {
      setState('error');
      setErrorMsg(result.error ?? 'Install failed');
    }
  }, [target]);

  if (state === 'success') {
    return <span className={`install-btn install-btn--success ${className}`}>{'\u2713'} Installed</span>;
  }

  if (state === 'installing') {
    return (
      <button className={`install-btn install-btn--installing ${className}`} disabled>
        <span className="install-btn-spinner" /> {'Installing\u2026'}
      </button>
    );
  }

  return (
    <span className={`install-btn-wrap ${className}`}>
      <button className={`install-btn${state === 'error' ? ' install-btn--error' : ''}`} onClick={handleClick}>
        {state === 'error' ? 'Retry' : label}
      </button>
      {state === 'error' && <span className="install-btn-error">{errorMsg}</span>}
    </span>
  );
}
