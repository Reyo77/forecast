import '@testing-library/jest-dom/vitest';

// jsdom's Blob/File may not implement .text(); polyfill it for upload tests.
if (!('text' in Blob.prototype)) {
  Object.defineProperty(Blob.prototype, 'text', {
    value: function text(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsText(this);
      });
    },
  });
}
// Recharts' ResponsiveContainer needs ResizeObserver.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;

// Full-suite runs execute many files in parallel; give async queries (findBy*/waitFor) headroom.
import { configure } from '@testing-library/react';
configure({ asyncUtilTimeout: 4000 });
