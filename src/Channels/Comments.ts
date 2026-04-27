import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';

const app = new Hono();

// Simple regex blocklist for profanity and spam
const BLOCKLIST_REGEX = /(badword|profanity|spamlink\.com)/i;

app.post('/scan', authMiddleware, async (c) => {
  const jwtPayload = c.get('jwtPayload') as { id: string, email: string };
  const body = await c.req.json();
  const { content, channel_short_id } = body;

  if (!content || !channel_short_id) {
    return c.json({ error: 'Content and channel_short_id are required' }, 400);
  }

  // 1. Fetch user to check if muted or suspended
  const { data: user } = await supabase
    .from('users')
    .select('is_muted, suspended_until, is_restricted')
    .eq('id', jwtPayload.id)
    .single();

  if (!user) return c.json({ error: 'User not found' }, 404);

  if (user.is_muted) {
    return c.json({ error: 'You are muted and cannot post comments' }, 403);
  }

  if (user.suspended_until && new Date(user.suspended_until) > new Date()) {
    return c.json({ error: 'Account suspended' }, 403);
  }

  // 2. Automated Moderation Scan
  if (BLOCKLIST_REGEX.test(content)) {
    // Here we would ideally add a "strike" to the user, but for now we just drop it or mute them if we had a strikes table.
    // As per the plan: 3 strikes = auto-mute for 2 hours. We can simulate it by just rejecting the comment.
    return c.json({ error: 'Message blocked by automated moderation' }, 400);
  }

  // 3. Insert Comment
  const { data: comment, error } = await supabase
    .from('comments')
    .insert({
      user_id: jwtPayload.id,
      channel_short_id,
      content
    })
    .select('*')
    .single();

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  // If shadow-banned, we inserted it so the user sees it, but the realtime feed to others should exclude comments from is_restricted=true users.
  // We can return success.
  return c.json({ message: 'Comment posted successfully', comment });
});

app.get('/:channel_short_id', async (c) => {
  const channel_short_id = c.req.param('channel_short_id');
  
  // Note: For a real app, this should join with the users table to get the author's avatar and username.
  // And filter out is_restricted=true authors unless it's the current user making the request.
  // For simplicity, we just fetch comments.
  const { data, error } = await supabase
    .from('comments')
    .select('id, content, created_at, users(username, avatar_url, is_verified, is_restricted)')
    .eq('channel_short_id', channel_short_id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return c.json({ error: error.message }, 500);

  // Filter out restricted users
  const filteredData = data.filter(comment => {
    // If we passed auth token, we would check if the current user is the author.
    // For now, public view drops restricted users entirely.
    const user = comment.users as any;
    if (user && user.is_restricted) return false;
    return true;
  });

  return c.json({ comments: filteredData });
});

export default app;
