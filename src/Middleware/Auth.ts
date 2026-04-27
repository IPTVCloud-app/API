import { Context, Next } from 'hono';
import { jwt } from 'hono/jwt';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only';

export const authMiddleware = async (c: Context, next: Next) => {
  const jwtMiddleware = jwt({
    secret: JWT_SECRET,
  } as any);
  return jwtMiddleware(c, next);
};
