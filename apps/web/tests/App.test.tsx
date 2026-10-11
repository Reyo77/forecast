import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, it, expect } from 'vitest';
import { App } from '../src/App';

it('renders the home route', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'SupplyCast' })).toBeInTheDocument();
});
