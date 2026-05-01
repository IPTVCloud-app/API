import { serve } from '@hono/node-server';
import { Hono, Context } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { rateLimiter } from 'hono-rate-limiter';

// Route Imports
import signUp from './Auth/SignUp.js';
import signIn from './Auth/SignIn.js';
import forgotPassword from './Auth/ForgotPassword.js';
import settings from './Account/Settings.js';
import privacy from './Account/Privacy.js';
import credentials from './Account/Credentials.js';
import twoFactor from './Account/TwoFactor.js';
import channels from './Channels/Channel.js';
import streamRouter from './Channels/Stream.js';
import streamStatus from './Channels/StreamStatus.js';
import thumbnail from './Channels/Thumbnail.js';
import logo from './Channels/Logo.js';
import metadata from './Channels/Metadata.js';
import wiki from './Channels/Wiki.js';
import profile from './Social/Profile.js';
import follow from './Social/Follow.js';
import adminDashboard from './Admin/Dashboard.js';
import adminUsers from './Admin/Users.js';
import comments from './Channels/Comments.js';
import iptv from './Channels/IPTV.js';
import playlists from './Channels/Playlists.js';

// Core Imports
import { errorHandler, notFoundHandler } from './ErrorHandler.js';
import { supabase } from './Database/DB.js';
import { getSystemStatus } from './Utils/StatusCheck.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';

const app = new Hono();

// 1. Global Middleware
app.use('*', logger());
app.use('*', cors({
  origin: (origin) => origin || '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
})); 

// 2. Universal Rate Limiting
const globalLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-6',
  keyGenerator: (c) => {
    try {
      return c.req.header('x-forwarded-for')?.split(',')[0] || c.req.header('x-real-ip') || 'anonymous';
    } catch {
      return 'anonymous';
    }
  },
});
app.use('*', globalLimiter);

app.get('/', (c) => {
  const frontendUrl = process.env.PUBLIC_FRONTEND_URL || 'https://iptvcloudapp.vercel.app';
  return c.redirect(frontendUrl);
});

app.get('/api/status', async (c) => {
  const status = await getSystemStatus();
  return c.json(status);
});

app.get('/api/image', async (c) => {
  const src = c.req.query('src');
  if (!src) return c.json({ error: 'Source required' }, 400);

  // Security: Prevent directory traversal
  const safeSrc = src.replace(/\.\.\//g, '');
  const assetPath = path.resolve(process.cwd(), '..', 'Assets', safeSrc);

  if (fs.existsSync(assetPath)) {
    const ext = path.extname(assetPath).toLowerCase();
    const contentType = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream';
    return c.body(fs.readFileSync(assetPath) as any, 200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
  }

  return c.json({ error: 'Image not found' }, 404);
});

// 5. Routes registration
app.route('/auth/signup', signUp);
app.route('/auth/signin', signIn);
app.route('/auth/forgot-password', forgotPassword);
app.route('/api/account/settings', settings);
app.route('/api/account/privacy', privacy);
app.route('/api/account/credentials', credentials);
app.route('/api/account/2fa', twoFactor);

// Modular Channel Routes
app.route('/api/channels/stream', streamRouter);

app.route('/api/channels/thumbnail', thumbnail);
app.route('/api/channels/logo', logo);
app.route('/api/channels/meta', metadata); // New base for categories, languages, etc.
app.route('/api/channels/wiki', wiki);
app.route('/api/channels', iptv);
app.route('/api/channels', channels);
app.route('/api/playlists', playlists);

app.route('/api/channels/comments', comments);
app.route('/api/social/profile', profile);
app.route('/api/social/follow', follow);
app.route('/api/admin/dashboard', adminDashboard);
app.route('/api/admin/users', adminUsers);

app.onError(errorHandler);
app.notFound(notFoundHandler);

export default async function handler(req: any, res: any) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  
  // req.url in Node includes the query string (e.g. /path?id=123)
  const fullUrl = `${protocol}://${host}${req.url}`;
  
  console.log(`[Vercel] Handling ${req.method} ${fullUrl}`);
  
  try {
    const result = await app.fetch(new Request(fullUrl, {
      method: req.method,
      headers: req.headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
      // @ts-ignore - duplex: 'half' is required for streaming bodies in some environments
      duplex: 'half'
    }));
    
    // Set status
    res.statusCode = result.status;
    
    // Copy headers safely
    result.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (result.body) {
      // Use streaming for better performance and support for binary data (thumbnails)
      Readable.fromWeb(result.body as any).pipe(res);
    } else {
      res.end();
    }

    console.log(`[Vercel] Response sent: ${result.status}`);
  } catch (err: any) {
    console.error('[Vercel] Fatal error:', err);
    res.statusCode = 500;
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      const requestId = req.headers['x-vercel-id'] || req.headers['x-request-id'] || 'internal';
      res.end(JSON.stringify({ 
        code: 500, 
        message: 'Fatal Server Error', 
        request_id: requestId,
        url: fullUrl 
      }));
    }
  }
}

if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  console.log(`Server is running on port ${port}`);
  serve({ fetch: app.fetch, port });
}
