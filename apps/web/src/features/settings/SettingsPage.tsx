import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Notice, PageHeader, errText } from '../../components/ui';
import { useTheme, type ThemeChoice } from '../../theme';
import { useAuth } from '../auth/AuthContext';

const OPTIONS: { value: ThemeChoice; label: string; icon: string; hint: string }[] = [
  { value: 'light', label: 'Light', icon: 'sun', hint: 'Bright and clean' },
  { value: 'dark', label: 'Dark', icon: 'moon', hint: 'Easy on the eyes' },
  { value: 'system', label: 'System', icon: 'cog', hint: 'Match your device' },
];

export function SettingsPage() {
  const { user, updateProfile } = useAuth();
  const theme = useTheme();
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dirty = name.trim() !== '' && name.trim() !== user?.name;
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await updateProfile(name.trim());
      setMsg('Profile updated.');
    } catch (ex) {
      setErr(errText(ex));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6">
      <PageHeader title="Settings" subtitle="Your profile and how SupplyCast looks for you." />

      <div className="card p-5">
        <h2 className="mb-3">Profile</h2>
        <form onSubmit={save} className="space-y-4" aria-label="Profile">
          {msg && <Notice kind="success">{msg}</Notice>}
          {err && <Notice kind="error">{err}</Notice>}
          <div className="grid gap-4 sm:grid-cols-3">
            <label>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
                className="w-full"
              />
            </label>
            <div className="text-sm">
              <p className="text-gray-600">Email</p>
              <p className="mt-2.5 font-medium text-gray-900">{user?.email}</p>
            </div>
            <div className="text-sm">
              <p className="text-gray-600">Role</p>
              <p className="mt-2.5 font-medium text-gray-900">{user?.role}</p>
            </div>
          </div>
          <button
            type="submit"
            disabled={!dirty || busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </div>

      <div className="card p-5">
        <h2 className="mb-1">Appearance</h2>
        <p className="mb-4 text-sm text-gray-500">
          Choose a theme. Your choice is remembered on this device.
        </p>
        <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
          {OPTIONS.map((o) => {
            const on = theme.choice === o.value;
            return (
              <button
                key={o.value}
                role="radio"
                aria-checked={on}
                onClick={() => theme.setChoice(o.value)}
                className={`flex items-center gap-3 border p-4 text-left ${on ? '!border-blue-600 ring-2 ring-blue-200' : ''}`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <Icon name={o.icon} />
                </span>
                <span>
                  <span className="block font-medium text-gray-900">{o.label}</span>
                  <span className="block text-xs text-gray-500">{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="mb-1">Security</h2>
        <p className="mb-3 text-sm text-gray-500">
          Keep your account safe with a strong, unique password.
        </p>
        <Link
          to="/change-password"
          className="inline-flex rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Change password
        </Link>
      </div>

      <div className="card p-5">
        <h2 className="mb-2">Keyboard shortcuts</h2>
        <ul className="space-y-1.5 text-sm text-gray-700">
          <li>
            <kbd className="rounded border border-gray-300 px-1.5 py-0.5 text-xs">Ctrl</kbd> /{' '}
            <kbd className="rounded border border-gray-300 px-1.5 py-0.5 text-xs">⌘</kbd> +{' '}
            <kbd className="rounded border border-gray-300 px-1.5 py-0.5 text-xs">K</kbd> &nbsp;
            Open the command palette
          </li>
        </ul>
      </div>
    </section>
  );
}
