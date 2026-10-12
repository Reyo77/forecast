import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { downloadFile } from '../../api/client';
import { Notice, errText } from '../../components/ui';
import { formatDate, formatMoney } from '../../lib';
import { DemoDataCard } from './DemoDataCard';
import { salesApi, type PreviewResult } from './api';

const MAX_BYTES = 10 * 1024 * 1024;

export function ImportPage() {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['imports'],
    queryFn: salesApi.imports,
    // Keep polling while a background import is still running.
    refetchInterval: (q) =>
      q.state.data?.items.some((i) => i.status === 'QUEUED' || i.status === 'PROCESSING')
        ? 1500
        : false,
  });

  const upload = useMutation({
    mutationFn: (v: { name: string; text: string }) => salesApi.preview(v.name, v.text),
    onSuccess: (r) => {
      setPreview(r);
      setErr(null);
      setMsg(null);
    },
    onError: (e) => {
      setPreview(null);
      setErr(errText(e));
    },
  });
  const commit = useMutation({
    mutationFn: (skipErrors: boolean) => salesApi.commit(preview!.import.id, skipErrors),
    onSuccess: () => {
      setMsg('Import queued. It runs in the background — progress shows in the history below.');
      setPreview(null);
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void qc.invalidateQueries({ queryKey: ['demo-status'] });
    },
    onError: (e) => setErr(errText(e)),
  });

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    if (file.size > MAX_BYTES) {
      setPreview(null);
      setErr('That file is larger than 10 MB. Split it into smaller files.');
      return;
    }
    upload.mutate({ name: file.name, text: await file.text() });
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Import sales history</h1>
        <button
          onClick={() =>
            void downloadFile('/imports/sales/template', 'sales-template.csv').catch((e) =>
              setErr(errText(e)),
            )
          }
          className="text-sm text-blue-600 underline"
        >
          Download CSV template
        </button>
      </div>
      <p className="text-sm text-gray-600">
        Columns: <code>sku, location_code, date, quantity, revenue</code> (revenue optional). Dates
        are <code>YYYY-MM-DD</code>; daily rows are summed into weeks starting Monday. Re-importing
        a week replaces it.
      </p>

      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice kind="success">{msg}</Notice>}

      <div
        data-testid="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFile(e.dataTransfer.files[0]);
        }}
        className={`rounded-lg border-2 border-dashed p-8 text-center ${dragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300'}`}
      >
        <p className="text-sm text-gray-700">Drag and drop a CSV here, or</p>
        <button
          onClick={() => fileInput.current?.click()}
          className="mt-2 rounded bg-blue-600 px-4 py-2 text-sm text-white"
        >
          Choose file
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          className="hidden"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {upload.isPending && <p className="mt-2 text-sm text-gray-500">Validating…</p>}
      </div>

      {preview && (
        <div className="space-y-4 rounded-lg border border-gray-200 p-4" data-testid="preview">
          <h2 className="text-lg font-semibold">Preview: {preview.import.fileName}</h2>
          <p className="text-sm" data-testid="preview-summary">
            {preview.import.rowCount} rows · <strong>{preview.import.validRowCount} valid</strong> ·{' '}
            <span className={preview.import.errorCount ? 'font-semibold text-red-700' : ''}>
              {preview.import.errorCount} with errors
            </span>{' '}
            · {preview.totalWeeklyRows} weekly records
          </p>
          {preview.errors.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold text-red-700">
                Errors
                {preview.import.errorCount > preview.errors.length
                  ? ` (first ${preview.errors.length} of ${preview.import.errorCount})`
                  : ''}
              </h3>
              <table className="w-full text-left text-sm">
                <thead className="border-b text-gray-500">
                  <tr>
                    <th className="py-1">Row</th>
                    <th>Field</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.errors.map((e, i) => (
                    <tr key={i} className="border-b bg-red-50" data-testid="error-row">
                      <td className="py-1">{e.row}</td>
                      <td>{e.field}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.sample.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold">Weekly records (sample)</h3>
              <table className="w-full text-left text-sm">
                <thead className="border-b text-gray-500">
                  <tr>
                    <th className="py-1">SKU</th>
                    <th>Location</th>
                    <th>Week of</th>
                    <th>Quantity</th>
                    <th>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i} className="border-b" data-testid="sample-row">
                      <td className="py-1">{r.sku}</td>
                      <td>{r.location}</td>
                      <td>{r.weekStart}</td>
                      <td>{r.quantity}</td>
                      <td>{formatMoney(r.revenueCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex gap-3">
            {preview.import.errorCount === 0 ? (
              <button
                onClick={() => commit.mutate(false)}
                disabled={commit.isPending || preview.import.validRowCount === 0}
                className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Import {preview.import.validRowCount} rows
              </button>
            ) : (
              <button
                onClick={() => commit.mutate(true)}
                disabled={commit.isPending || preview.import.validRowCount === 0}
                className="rounded bg-amber-600 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Import {preview.import.validRowCount} valid rows, skip {preview.import.errorCount}
              </button>
            )}
            <button onClick={() => setPreview(null)} className="rounded border px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
          {preview.import.errorCount > 0 && (
            <p className="text-xs text-gray-500">Or fix the file and upload it again.</p>
          )}
        </div>
      )}

      <DemoDataCard />

      <div>
        <h2 className="mb-2 text-lg font-semibold">Import history</h2>
        {history.data && history.data.items.length === 0 ? (
          <p className="text-sm text-gray-500">No imports yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b text-gray-500">
              <tr>
                <th className="py-2">File</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Imported</th>
                <th>Errors</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.items.map((i) => (
                <tr key={i.id} className="border-b align-top" data-testid={`import-${i.fileName}`}>
                  <td className="py-2">{i.fileName}</td>
                  <td>
                    <span
                      className={
                        i.status === 'FAILED'
                          ? 'font-semibold text-red-700'
                          : i.status === 'DONE'
                            ? 'text-green-700'
                            : 'text-amber-700'
                      }
                    >
                      {i.status}
                    </span>
                    {i.errorMessage && <p className="text-xs text-red-700">{i.errorMessage}</p>}
                  </td>
                  <td>{i.rowCount}</td>
                  <td>{i.importedRows}</td>
                  <td>{i.errorCount}</td>
                  <td>{formatDate(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
