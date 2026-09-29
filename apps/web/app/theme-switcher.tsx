'use client';

import { useEffect, useRef, useState } from 'react';

export type Theme = 'orbit' | 'ledger';

const storageKey = 'ohmyfund-theme';
const themes: { id: Theme; label: string }[] = [
  { id: 'orbit', label: 'Orbit' },
  { id: 'ledger', label: 'Ledger' },
];

function isTheme(value: string | null): value is Theme {
  return themes.some(theme => theme.id === value);
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>('orbit');
  const hasSelectedTheme = useRef(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!hasSelectedTheme.current && isTheme(saved)) {
        setTheme(saved);
        document.documentElement.dataset.theme = saved;
      } else if (saved) {
        localStorage.removeItem(storageKey);
      }
    } catch { /* private browsing may block storage */ }
  }, []);

  function selectTheme(next: Theme) {
    hasSelectedTheme.current = true;
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(storageKey, next); } catch { /* choice still works in this tab */ }
  }

  return <div className="theme-switcher" role="group" aria-label="Appearance theme">
    <span className="theme-switcher-label">Theme</span>
    {themes.map(option => <button key={option.id} type="button" aria-pressed={theme === option.id} onClick={() => selectTheme(option.id)}>{option.label}</button>)}
  </div>;
}
