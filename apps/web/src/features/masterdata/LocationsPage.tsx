import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LOCATION_TYPES, type LocationType } from '@supplycast/shared';
import { Notice, errText, inputCls } from '../../components/ui';
import { Can } from '../auth/Can';
import { mdApi } from './api';

export function LocationsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['locations'], queryFn: mdApi.locations });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<LocationType>('WAREHOUSE');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    setErr(null);
    void qc.invalidateQueries({ queryKey: ['locations'] });
    void qc.invalidateQueries({ queryKey: ['billing'] });
  };
  const bad = (e: unknown) => {
    setErr(errText(e));
    setMsg(null);
  };
  const create = useMutation({
    mutationFn: () => mdApi.createLocation({ code, name, type }),
    onSuccess: () => {
      setCode('');
      setName('');
      done('Location created.');
    },
    onError: bad,
  });
  const del = useMutation({
    mutationFn: mdApi.deleteLocation,
    onSuccess: () => done('Location deleted.'),
    onError: bad,
  });
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Locations</h1>
      {msg && <Notice kind="success">{msg}</Notice>}
      {err && <Notice kind="error">{err}</Notice>}
      <Can permission="masterdata:write">
        <form
          aria-label="New location"
          className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Code
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={inputCls}
            />
          </label>
          <label>
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </label>
          <label>
            Type
            <select
              value={type}
              onChange={(e) => setType(e.target.value as LocationType)}
              className={inputCls}
            >
              {LOCATION_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
            Add location
          </button>
        </form>
      </Can>
      {isLoading ? (
        <p>Loading…</p>
      ) : data && data.items.length === 0 ? (
        <p className="text-sm text-gray-500">No locations yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2">Code</th>
              <th>Name</th>
              <th>Type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((l) => (
              <tr key={l.id} className="border-b" data-testid={`location-${l.code}`}>
                <td className="py-2">{l.code}</td>
                <td>{l.name}</td>
                <td>{l.type}</td>
                <td className="text-right">
                  <Can permission="masterdata:write">
                    <button
                      onClick={() => del.mutate(l.id)}
                      className="rounded border border-red-300 px-2 py-0.5 text-red-700"
                    >
                      Delete
                    </button>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
