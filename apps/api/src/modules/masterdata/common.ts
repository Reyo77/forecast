import type { Prisma } from '@prisma/client';
import { HttpError } from '../../middleware/errors';

export const num = (d: Prisma.Decimal | number | null | undefined): number =>
  d === null || d === undefined ? 0 : Number(d);

export const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

type Checker = (tenantId: string, id: string) => Promise<string | null>;
const checkers = { product: [] as Checker[], location: [] as Checker[] };

/**
 * Later features (sales history, forecasts) register why a product/location must not be deleted.
 * A non-null reason blocks the delete with 409 and points the user at "deactivate".
 */
export function registerDeleteGuard(kind: 'product' | 'location', check: Checker) {
  checkers[kind].push(check);
}

export async function assertDeletable(kind: 'product' | 'location', tenantId: string, id: string) {
  for (const check of checkers[kind]) {
    const reason = await check(tenantId, id);
    if (reason) {
      throw new HttpError(
        409,
        `${kind.toUpperCase()}_IN_USE`,
        `${reason}${kind === 'product' ? ' Deactivate it instead.' : ''}`,
      );
    }
  }
}
