import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSIGNABLE_ROLES, type AssignableRole, type TeamUser } from '@supplycast/shared';
import { CopyLink } from '../../components/CopyLink';
import { useAuth } from '../auth/AuthContext';
import { Can } from '../auth/Can';
import { api } from '../../api/client';
import { teamApi } from './api';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function TeamPage() {
  const { user: me, logout } = useAuth();
  const [deletePw, setDeletePw] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['team', 'users'], queryFn: teamApi.users });
  const invites = useQuery({ queryKey: ['team', 'invites'], queryFn: teamApi.invites });
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ label: string; url: string; emailedTo?: string } | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('PLANNER');
  const [transferTo, setTransferTo] = useState('');
  const [transferPw, setTransferPw] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] });
  const onError = (e: unknown) => setError(errMsg(e));

  const invite = useMutation({
    mutationFn: teamApi.invite,
    onSuccess: (res) => {
      setLink({
        label: `Invite link for ${res.invite.email} (valid 7 days)`,
        url: res.link,
        emailedTo: res.emailed ? res.invite.email : undefined,
      });
      setEmail('');
      setShowInvite(false);
      setError(null);
      void refresh();
    },
    onError,
  });
  const revoke = useMutation({ mutationFn: teamApi.revokeInvite, onSuccess: refresh, onError });
  const update = useMutation({
    mutationFn: (v: { id: string; role?: AssignableRole; isActive?: boolean }) =>
      teamApi.updateUser(v.id, {
        ...(v.role && { role: v.role }),
        ...(v.isActive !== undefined && { isActive: v.isActive }),
      }),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError,
  });
  const reset = useMutation({
    mutationFn: teamApi.resetLink,
    onSuccess: (res, id) => {
      const name = users.data?.items.find((u) => u.id === id)?.email ?? 'user';
      setLink({
        label: `Password reset link for ${name} (valid 24 hours)`,
        url: res.link,
        emailedTo: res.emailed ? name : undefined,
      });
      setError(null);
    },
    onError,
  });
  const transfer = useMutation({
    mutationFn: () => teamApi.transferOwnership(transferTo, transferPw),
    onSuccess: () => {
      setNotice('Ownership transferred. You are now an Admin — reload to see your new access.');
      setTransferPw('');
      void refresh();
    },
    onError,
  });

  const delTenant = useMutation({
    mutationFn: () => api('/tenant', 'DELETE', { password: deletePw }),
    onSuccess: () => void logout(),
    onError,
  });
  const isOwner = me?.role === 'OWNER';
  const canEditRow = (u: TeamUser) => u.role !== 'OWNER' && u.id !== me?.id;

  return (
    <section className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Team</h1>
        <Can permission="team:manage">
          <button
            onClick={() => setShowInvite((s) => !s)}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white"
          >
            Invite user
          </button>
        </Can>
      </div>

      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded bg-green-50 p-2 text-sm text-green-700">
          {notice}
        </p>
      )}
      {link && <CopyLink label={link.label} link={link.url} emailedTo={link.emailedTo} />}

      {showInvite && (
        <form
          aria-label="Invite user"
          className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({ email, role });
          }}
        >
          <label className="text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block rounded border px-2 py-1"
            />
          </label>
          <label className="text-sm">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as AssignableRole)}
              className="mt-1 block rounded border px-2 py-1"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={invite.isPending}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-60"
          >
            Create invite
          </button>
        </form>
      )}

      <div>
        <h2 className="mb-2 text-lg font-semibold">Members</h2>
        {users.isLoading ? (
          <p>Loading…</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b text-gray-500">
              <tr>
                <th className="py-2">Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.items.map((u) => (
                <tr key={u.id} className="border-b" data-testid={`user-${u.email}`}>
                  <td className="py-2">{u.name}</td>
                  <td>{u.email}</td>
                  <td>
                    {canEditRow(u) ? (
                      <select
                        aria-label={`Role for ${u.email}`}
                        value={u.role}
                        onChange={(e) =>
                          update.mutate({ id: u.id, role: e.target.value as AssignableRole })
                        }
                        className="rounded border px-1 py-0.5"
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    ) : (
                      u.role
                    )}
                  </td>
                  <td>{u.isActive ? 'Active' : 'Deactivated'}</td>
                  <td className="space-x-2 text-right">
                    {canEditRow(u) && (
                      <button
                        onClick={() => update.mutate({ id: u.id, isActive: !u.isActive })}
                        className="rounded border px-2 py-0.5"
                      >
                        {u.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                    {(u.role !== 'OWNER' || isOwner) && (
                      <button
                        onClick={() => reset.mutate(u.id)}
                        className="rounded border px-2 py-0.5"
                      >
                        Reset link
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Pending invites</h2>
        {invites.data?.items.length ? (
          <table className="w-full text-left text-sm">
            <tbody>
              {invites.data.items.map((i) => (
                <tr key={i.id} className="border-b" data-testid={`invite-${i.email}`}>
                  <td className="py-2">{i.email}</td>
                  <td>{i.role}</td>
                  <td>
                    {i.expired
                      ? 'Expired'
                      : `Expires ${new Date(i.expiresAt).toLocaleDateString()}`}
                  </td>
                  <td className="text-right">
                    <Can permission="team:manage">
                      <button
                        onClick={() => revoke.mutate(i.id)}
                        className="rounded border px-2 py-0.5"
                      >
                        Revoke
                      </button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-500">No pending invites.</p>
        )}
      </div>

      <Can permission="tenant:transfer-ownership">
        <form
          aria-label="Transfer ownership"
          className="space-y-2 rounded border border-amber-200 bg-amber-50 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            transfer.mutate();
          }}
        >
          <h2 className="font-semibold">Transfer ownership</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              New owner
              <select
                required
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                className="mt-1 block rounded border px-2 py-1"
              >
                <option value="">Select…</option>
                {users.data?.items
                  .filter((u) => u.id !== me?.id && u.isActive)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-sm">
              Your password
              <input
                type="password"
                required
                value={transferPw}
                onChange={(e) => setTransferPw(e.target.value)}
                className="mt-1 block rounded border px-2 py-1"
              />
            </label>
            <button type="submit" className="rounded bg-amber-600 px-4 py-1.5 text-sm text-white">
              Transfer
            </button>
          </div>
        </form>
      </Can>
      <Can permission="tenant:delete">
        <section
          className="space-y-2 rounded border border-red-300 bg-red-50 p-4"
          aria-label="Danger zone"
        >
          <h2 className="font-semibold text-red-800">Danger zone</h2>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded border border-red-400 px-3 py-1.5 text-sm text-red-800"
            >
              Delete this company…
            </button>
          ) : (
            <form
              className="flex flex-wrap items-end gap-3 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                delTenant.mutate();
              }}
            >
              <p className="w-full text-red-800">
                This signs everyone out and disables the account. Enter your password to confirm.
              </p>
              <label>
                Your password
                <input
                  type="password"
                  required
                  value={deletePw}
                  onChange={(e) => setDeletePw(e.target.value)}
                  className="mt-1 block rounded border px-2 py-1"
                />
              </label>
              <button type="submit" className="rounded bg-red-700 px-4 py-1.5 text-white">
                Permanently delete company
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded border px-3 py-1.5"
              >
                Cancel
              </button>
            </form>
          )}
        </section>
      </Can>
    </section>
  );
}
