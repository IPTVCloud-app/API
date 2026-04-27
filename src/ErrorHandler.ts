import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Global Error Handler for Hono
 * Ensures all errors (404, 500, etc.) return a clean JSON response.
 */
export const errorHandler = (err: Error, c: Context) => {
  console.error(`[Error] ${c.req.method} ${c.req.url}:`, err);

  const requestId = c.req.header('x-vercel-id') || c.req.header('x-request-id') || 'internal';
  const url = c.req.url;

  if (err instanceof HTTPException) {
    return c.json(
      {
        code: err.status,
        message: err.message || 'An HTTP error occurred',
        request_id: requestId,
        url: url
      },
      err.status
    );
  }

  // Handle common runtime errors (like null database client)
  if (err.message?.includes('null') && err.message?.includes('supabase')) {
    return c.json({
      code: 503,
      message: 'Database connection is not configured correctly.',
      request_id: requestId,
      url: url
    }, 503);
  }

  // Handle generic errors
  return c.json(
    {
      code: 500,
      message: err.message || 'Internal Server Error',
      request_id: requestId,
      url: url
    },
    500
  );
};

export const notFoundHandler = (c: Context) => {
  const requestId = c.req.header('x-vercel-id') || c.req.header('x-request-id') || 'internal';
  return c.json(
    {
      code: 404,
      message: 'Not found.',
      request_id: requestId,
      url: c.req.url
    },
    404
  );
};
