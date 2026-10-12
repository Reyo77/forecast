import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}
interface NotificationsResponse {
  items: Notification[];
  unreadCount: number;
}

/** Bell with an unread count; clicking a notification marks it read. */
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationsResponse>('/notifications?pageSize=10'),
    refetchInterval: 15_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const read = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, 'POST'),
    onSuccess: refresh,
  });
  const readAll = useMutation({
    mutationFn: () => api('/notifications/read-all', 'POST'),
    onSuccess: refresh,
  });
  const { pathname } = useLocation();
  // Background jobs finish while the user browses: look again whenever they move to another page.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  }, [pathname, qc]);
  const unread = data?.unreadCount ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications, ${unread} unread`}
        aria-expanded={open}
        className="relative rounded border px-2 py-1 text-sm"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span
            data-testid="unread-badge"
            className="absolute -right-2 -top-2 rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-gray-200 bg-white p-2 shadow-xl"
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <strong className="text-sm">Notifications</strong>
            <button
              onClick={() => readAll.mutate()}
              disabled={unread === 0}
              className="text-xs text-blue-600 underline disabled:opacity-40"
            >
              Mark all read
            </button>
          </div>
          {data && data.items.length === 0 ? (
            <p className="p-3 text-sm text-gray-500" data-testid="no-notifications">
              You're all caught up.
            </p>
          ) : (
            <ul className="max-h-80 divide-y overflow-y-auto">
              {data?.items.map((n) => (
                <li key={n.id} data-testid={`notification-${n.id}`}>
                  <button
                    onClick={() => !n.readAt && read.mutate(n.id)}
                    className={`w-full px-2 py-2 text-left text-sm ${n.readAt ? 'text-gray-500' : 'font-medium'}`}
                  >
                    {!n.readAt && (
                      <span
                        className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-600"
                        aria-label="unread"
                      />
                    )}
                    {n.title}
                    <span className="block text-xs font-normal text-gray-600">{n.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
