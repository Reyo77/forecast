import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import { useCan } from '../features/auth/Can';
import { useThemeSafe } from '../theme';
import { Icon } from './Icon';
import { NAV_ITEMS } from './navItems';

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: string;
  run: () => void;
}

/** Ctrl/⌘ + K: jump anywhere or run common actions from the keyboard. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const can = useCan();
  const { logout } = useAuth();
  const theme = useThemeSafe();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go: Command[] = NAV_ITEMS.filter((i) => can(i.permission)).map((i) => ({
      id: i.to,
      label: i.label,
      hint: i.group,
      icon: i.icon,
      run: () => navigate(i.to),
    }));
    go.push({
      id: 'settings',
      label: 'Settings',
      hint: 'Account',
      icon: 'cog',
      run: () => navigate('/settings'),
    });
    if (theme)
      go.push({
        id: 'theme',
        label: theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        hint: 'Appearance',
        icon: theme.resolved === 'dark' ? 'sun' : 'moon',
        run: theme.toggle,
      });
    go.push({
      id: 'logout',
      label: 'Log out',
      hint: 'Account',
      icon: 'logout',
      run: () => void logout().then(() => navigate('/login')),
    });
    return go;
  }, [can, navigate, theme, logout]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? commands.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(needle))
      : commands;
  }, [commands, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setActive(0), [q]);

  if (!open) return null;
  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh] print:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="absolute inset-0 bg-gray-900/50" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-pop">
        <div className="flex items-center gap-3 border-b border-gray-200 px-4">
          <Icon name="search" className="h-5 w-5 text-gray-400" />
          <input
            ref={inputRef}
            aria-label="Search commands"
            placeholder="Go to a page or run an action…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(results[active]);
              } else if (e.key === 'Escape') onClose();
            }}
            className="!border-0 !bg-transparent !shadow-none !ring-0 py-3.5 text-base"
          />
          <kbd className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-500">
            Esc
          </kbd>
        </div>
        <ul role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-gray-500">No matches</li>
          )}
          {results.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === active}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(c)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${i === active ? 'bg-blue-50 text-blue-700' : 'text-gray-700'}`}
              >
                <Icon name={c.icon} className="h-[18px] w-[18px]" />
                <span className="flex-1">{c.label}</span>
                <span className="text-xs text-gray-400">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
