import request from 'supertest';
import express from 'express';
import { z } from 'zod';
import { createApp } from './app';
import { errorHandler, HttpError } from './middleware/errors';

const app = createApp({ APP_URL: 'http://localhost:5173' });

describe('app', () => {
  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('unknown route returns formatted 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('malformed JSON returns 400', async () => {
    const res = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('error handler', () => {
  const build = (thrower: () => never) => {
    const a = express();
    a.get('/boom', () => thrower());
    a.use(errorHandler);
    return a;
  };

  it('formats Zod errors as 400', async () => {
    const res = await request(build(() => z.object({ a: z.string() }).parse({}) as never)).get(
      '/boom',
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fieldErrors.a).toBeDefined();
  });

  it('formats HttpError', async () => {
    const res = await request(
      build(() => {
        throw new HttpError(402, 'PLAN_LIMIT_REACHED', 'Limit', { metric: 'users' });
      }),
    ).get('/boom');
    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: { code: 'PLAN_LIMIT_REACHED', message: 'Limit', details: { metric: 'users' } },
    });
  });

  it('hides unexpected errors behind a 500', async () => {
    const res = await request(
      build(() => {
        throw new Error('secret internals');
      }),
    ).get('/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
