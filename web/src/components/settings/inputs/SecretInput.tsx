import { useState } from 'react';

interface SecretInputProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
}

export function SecretInput({ id, value, onChange, onBlur, placeholder, disabled }: SecretInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="secret-input-wrapper">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        className="secret-input"
        autoComplete="off"
        disabled={disabled}
      />
      <button
        type="button"
        className="secret-toggle"
        onClick={() => setVisible(!visible)}
        aria-label={visible ? 'Hide' : 'Show'}
        tabIndex={0}
      >
        {visible ? '◉' : '○'}
      </button>
    </div>
  );
}
