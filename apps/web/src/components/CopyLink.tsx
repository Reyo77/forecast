import { useState } from 'react';

export function CopyLink({ label, link }: { label: string; link: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context); the field below can still be copied by hand.
      setCopied(false);
    }
  }
  return (
    <div className="rounded border border-green-200 bg-green-50 p-3" data-testid="copy-link">
      <p className="text-sm font-medium text-green-800">{label}</p>
      <div className="mt-2 flex gap-2">
        <input
          readOnly
          aria-label="Link"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded bg-green-700 px-3 py-1 text-xs text-white"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-600">
        Share this link manually — it is shown only once.
      </p>
    </div>
  );
}
