import { Outlet } from 'react-router-dom';
import type { Permission } from '@supplycast/shared';
import { useCan } from './Can';

export function Forbidden() {
  return (
    <section className="p-8" data-testid="forbidden">
      <h1 className="text-2xl font-bold">Not allowed</h1>
      <p className="mt-2 text-gray-600">Your role does not have access to this page.</p>
    </section>
  );
}

/** Route guard: UI convenience only — the API enforces the same permission independently. */
export function RequirePermission({ permission }: { permission: Permission }) {
  const allowed = useCan()(permission);
  return allowed ? <Outlet /> : <Forbidden />;
}
