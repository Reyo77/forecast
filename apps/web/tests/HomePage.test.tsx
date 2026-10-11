import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../src/routes/HomePage';

describe('HomePage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the heading and API status ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<HomePage />);
    expect(screen.getByRole('heading', { name: 'SupplyCast' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('api-status')).toHaveTextContent('API: ok'));
  });

  it('shows down when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<HomePage />);
    await waitFor(() => expect(screen.getByTestId('api-status')).toHaveTextContent('API: down'));
  });
});
