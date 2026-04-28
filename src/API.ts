import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { handle } from 'hono/vercel';
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
import thumbnail from './Channels/Thumbnail.js';
import profile from './Social/Profile.js';
import follow from './Social/Follow.js';
import adminDashboard from './Admin/Dashboard.js';
import adminUsers from './Admin/Users.js';
import comments from './Channels/Comments.js';
import iptv from './Channels/IPTV.js';

// Core Imports
import { errorHandler, notFoundHandler } from './ErrorHandler.js';
import { supabase } from './Database/DB.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';

const app = new Hono();

// 1. Global Middleware
app.use('*', logger());
app.use('*', cors()); 

// 2. Universal Rate Limiting
const globalLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-6',
  keyGenerator: (c) => {
    try {
      return c.req.header('x-forwarded-for') || c.req.header('remote-addr') || 'anonymous';
    } catch {
      return 'anonymous';
    }
  },
});
app.use('*', globalLimiter);

// 3. Root Redirect
app.get('/', (c) => {
  const frontendUrl = process.env.PUBLIC_FRONTEND_URL || 'https://iptvcloudapp.vercel.app';
  return c.redirect(frontendUrl);
});

// Health Check
app.get('/api/health', (c) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  // Mock data for frontend graphs (last 7 data points)
  const stats = {
    latency: [45, 52, 48, 61, 44, 49, 50], // ms
    requests: [120, 145, 132, 110, 156, 140, 148], // req/min
    errors: [0, 1, 0, 0, 2, 0, 0]
  };

  return c.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    version: '1.2.0',
    uptime: {
      seconds: Math.floor(uptime),
      readable: new Date(uptime * 1000).toISOString().substr(11, 8)
    },
    memory: {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB'
    },
    database: {
      connected: !!supabase,
    },
    statistics: stats,
    time: new Date().toISOString()
  });
});

// 4. Admin Cleanup (Vercel Cron)
app.get('/api/admin/cleanup', (c) => {
  console.log('🧹 Running daily thumbnail cleanup...');
  const tempDir = path.join(os.tmpdir(), 'iptvcloud-thumbnails');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    let count = 0;
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        count++;
      }
    });
    return c.json({ message: `Cleanup complete. Deleted ${count} files.` });
  }
  return c.json({ message: 'No cleanup needed.' });
});

// 5. Routes registration
app.route('/auth/signup', signUp);
app.route('/auth/signin', signIn);
app.route('/auth/forgot-password', forgotPassword);
app.route('/api/account/settings', settings);
app.route('/api/account/privacy', privacy);
app.route('/api/account/credentials', credentials);
app.route('/api/account/2fa', twoFactor);
app.route('/api/channels/thumbnail', thumbnail);
app.route('/api/channels/logo', thumbnail);
app.route('/api/channels', channels);
app.route('/api/channels/comments', comments);
app.route('/api/channels', iptv);
app.route('/api/social/profile', profile);
app.route('/api/social/follow', follow);
app.route('/api/admin/dashboard', adminDashboard);
app.route('/api/admin/users', adminUsers);

// 5. Global Error & 404 Handlers
app.onError(errorHandler);
app.notFound(notFoundHandler);

// Vercel Handler refactored for direct Node.js compatibility
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

// Local Server logic
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  console.log(`Server is running on port ${port}`);
  serve({ fetch: app.fetch, port });
}
