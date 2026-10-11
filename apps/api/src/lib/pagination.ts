import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paged<T>(
  items: T[],
  total: number,
  p: { page: number; pageSize: number },
): Page<T> {
  return { items, total, page: p.page, pageSize: p.pageSize };
}

export const skipTake = (p: { page: number; pageSize: number }) => ({
  skip: (p.page - 1) * p.pageSize,
  take: p.pageSize,
});
