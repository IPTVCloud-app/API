import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { handle } from 'hono/vercel';
import { rateLimiter } from 'hono-rate-limiter';
import images from './routes/images.js';
import auth from './routes/auth.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: (origin) => {
    const envOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : [];
    const defaultOrigins = ['https://iptvcloudapp.vercel.app', 'http://localhost:3000'];
    const allowedOrigins = [...new Set([...envOrigins, ...defaultOrigins])];
    
    return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Rate Limiter for Auth
const authLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // Increased limit to accommodate OTP requests
  standardHeaders: 'draft-6',
  keyGenerator: (c) => c.req.header('x-forwarded-for') || '', 
});

// Health Check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    message: 'IPTVCloud Backend is running',
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use('/auth/*', authLimiter);
app.route('/api/image', images);
app.route('/auth', auth);

// Export for Vercel
export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);

// Local Server logic (ignored by Vercel)
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  console.log(`Server is running on port ${port}`);

  serve({
    fetch: app.fetch,
    port,
  });
}

export default handle(app);