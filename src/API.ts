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

// Core Imports
import { errorHandler, notFoundHandler } from './ErrorHandler.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = new Hono();

// 1. Global Middleware
app.use('*', logger());
app.use('*', cors()); // Use default CORS for maximum compatibility with Vercel environment

// 2. Universal Rate Limiting
const globalLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // 100 requests per IP per window
  standardHeaders: 'draft-6',
  keyGenerator: (c) => {
    // Safely get header for Vercel/Node environment
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
app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

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
app.route('/api/channels', channels);
app.route('/api/channels/thumbnail', thumbnail);
app.route('/api/channels/comments', comments);
app.route('/api/social/profile', profile);
app.route('/api/social/follow', follow);
app.route('/api/admin/dashboard', adminDashboard);
app.route('/api/admin/users', adminUsers);

// 5. Global Error & 404 Handlers
app.onError(errorHandler);
app.notFound(notFoundHandler);

// Local Server logic
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  console.log(`Server is running on port ${port}`);
  serve({ fetch: app.fetch, port });
}

export default handle(app);
