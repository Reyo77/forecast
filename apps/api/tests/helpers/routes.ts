import type { Express } from 'express';

export interface RouteInfo {
  method: string;
  path: string;
  guards: string[];
}

interface Layer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: { guard?: string } }[];
  };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: { source: string; fast_slash?: boolean };
}

/** Converts an Express mount regexp (e.g. ^\/auth\/?(?=\/|$)) back to its path (/auth). */
function mountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  return layer.regexp.source.replace('^', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
}

/** Every registered route with the guard markers (auth / tenant / role) found in its middleware stack. */
export function listRoutes(app: Express): RouteInfo[] {
  const out: RouteInfo[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const guards = layer.route.stack.map((l) => l.handle.guard).filter((g): g is string => !!g);
        for (const method of Object.keys(layer.route.methods))
          out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, guards });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, '');
  return out;
}
