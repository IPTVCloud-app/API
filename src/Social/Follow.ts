import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';

const app = new Hono();

// All follow routes require authentication
app.use('*', authMiddleware);

app.get('/status/:username', async (c) => {
  const jwtPayload = c.get('jwtPayload') as { id: string, username: string };
  const targetUsername = c.req.param('username');

  // Find target user id
  const { data: targetUser } = await supabase
    .from('users')
    .select('id')
    .eq('username', targetUsername)
    .single();

  if (!targetUser) return c.json({ error: 'User not found' }, 404);

  // Check if current user follows target user
  const { data: followRecord } = await supabase
    .from('followers')
    .select('*')
    .eq('follower_id', jwtPayload.id)
    .eq('following_id', targetUser.id)
    .single();

  return c.json({ isFollowing: !!followRecord });
});

app.post('/toggle/:username', async (c) => {
  const jwtPayload = c.get('jwtPayload') as { id: string, username: string };
  const targetUsername = c.req.param('username');

  // Prevent self-follow
  if (jwtPayload.username === targetUsername) {
    return c.json({ error: 'Cannot follow yourself' }, 400);
  }

  // Find target user id
  const { data: targetUser } = await supabase
    .from('users')
    .select('id')
    .eq('username', targetUsername)
    .single();

  if (!targetUser) return c.json({ error: 'User not found' }, 404);

  // Check current status
  const { data: followRecord } = await supabase
    .from('followers')
    .select('*')
    .eq('follower_id', jwtPayload.id)
    .eq('following_id', targetUser.id)
    .single();

  if (followRecord) {
    // Unfollow
    await supabase
      .from('followers')
      .delete()
      .eq('follower_id', jwtPayload.id)
      .eq('following_id', targetUser.id);
    return c.json({ isFollowing: false });
  } else {
    // Follow
    await supabase
      .from('followers')
      .insert({
        follower_id: jwtPayload.id,
        following_id: targetUser.id
      });
    return c.json({ isFollowing: true });
  }
});

export default app;
