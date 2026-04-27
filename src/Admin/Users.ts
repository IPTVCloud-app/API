import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';
import { requireRole } from '../Middleware/RBAC.js';

const app = new Hono();

app.use('*', authMiddleware);
app.use('*', requireRole(['admin', 'moderator']));

// List Users
app.get('/', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const search = c.req.query('search') || '';

  const offset = (page - 1) * limit;

  let query = supabase
    .from('users')
    .select('id, username, email, role, is_verified, suspended_until, is_muted, is_restricted, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.ilike('username', `%${search}%`);
  }

  const { data, count, error } = await query;

  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    data,
    meta: {
      total: count,
      page,
      limit,
      totalPages: count ? Math.ceil(count / limit) : 0
    }
  });
});

// Perform Action
app.post('/:id/action', async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json();
  const { action, value } = body; // action: 'suspend', 'mute', 'restrict'

  if (!['suspend', 'mute', 'restrict'].includes(action)) {
    return c.json({ error: 'Invalid action' }, 400);
  }

  const updatePayload: any = {};
  
  if (action === 'suspend') {
    // value should be an ISO date string or null to lift
    updatePayload.suspended_until = value;
  } else if (action === 'mute') {
    // value is boolean
    updatePayload.is_muted = value;
  } else if (action === 'restrict') {
    // value is boolean (shadow ban)
    updatePayload.is_restricted = value;
  }

  const { data, error } = await supabase
    .from('users')
    .update(updatePayload)
    .eq('id', userId)
    .select('id, username, email, suspended_until, is_muted, is_restricted')
    .single();

  if (error) return c.json({ error: error.message }, 500);

  return c.json({ message: 'User updated successfully', user: data });
});

// Purge comments
app.post('/:id/purge_comments', async (c) => {
  const userId = c.req.param('id');
  // Last 24 hours
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('comments')
    .delete()
    .eq('user_id', userId)
    .gte('created_at', yesterday);

  if (error) return c.json({ error: error.message }, 500);

  return c.json({ message: 'Comments purged for the last 24 hours' });
});

export default app;
