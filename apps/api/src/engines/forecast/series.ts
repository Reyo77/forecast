const WEEK = 7 * 86400_000;

export interface WeeklyPoint {
  weekStart: number; // epoch ms of the Monday (UTC)
  quantity: number;
}

/**
 * Turns sparse weekly sales into a dense zero-filled series from the first sale to `endWeek`.
 * Weeks without a record are zero demand.
 */
export function densify(
  points: WeeklyPoint[],
  endWeek: number,
): { start: number; values: number[] } {
  if (points.length === 0) return { start: endWeek, values: [] };
  const byWeek = new Map(points.map((p) => [p.weekStart, p.quantity]));
  const start = Math.min(...points.map((p) => p.weekStart));
  const n = Math.max(0, Math.round((endWeek - start) / WEEK)) + 1;
  return { start, values: Array.from({ length: n }, (_, i) => byWeek.get(start + i * WEEK) ?? 0) };
}

export const weeksAfter = (endWeek: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => endWeek + (i + 1) * WEEK);
