import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Global Error Handler for Hono
 * Ensures all errors (404, 500, etc.) return a clean JSON response.
 */
export const errorHandler = (err: Error, c: Context) => {
  console.error(`[Error] ${c.req.method} ${c.req.url}:`, err);

  if (err instanceof HTTPException) {
    return c.json(
      {
        error: err.message || 'An HTTP error occurred',
        status: err.status,
      },
      err.status
    );
  }

  // Handle common runtime errors (like null database client)
  if (err.message?.includes('null') && err.message?.includes('supabase')) {
    return c.json({
      error: 'Database connection is not configured correctly.',
      status: 503
    }, 503);
  }

  // Handle generic errors
  return c.json(
    {
      error: err.message || 'Internal Server Error',
      status: 500,
    },
    500
  );
};

export const notFoundHandler = (c: Context) => {
  return c.json(
    {
      error: `Route not found: ${c.req.method} ${c.req.url}`,
      status: 404,
    },
    404
  );
};
