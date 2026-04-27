import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';

const app = new Hono();

app.get('/:username', async (c) => {
  const username = c.req.param('username');

  // Fetch user basic info
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, username, is_verified, avatar_url, created_at')
    .eq('username', username)
    .single();

  if (userError || !user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Fetch privacy settings
  const { data: privacy } = await supabase
    .from('user_privacy')
    .select('show_followers, show_following, show_watch_history')
    .eq('user_id', user.id)
    .single();

  const privacySettings = privacy || {
    show_followers: true,
    show_following: true,
    show_watch_history: true
  };

  // Fetch counts
  const { count: followersCount } = await supabase
    .from('followers')
    .select('*', { count: 'exact', head: true })
    .eq('following_id', user.id);

  const { count: followingCount } = await supabase
    .from('followers')
    .select('*', { count: 'exact', head: true })
    .eq('follower_id', user.id);

  // Fetch watch history if permitted
  let watchHistory: any[] = [];
  if (privacySettings.show_watch_history) {
    const { data: history } = await supabase
      .from('watch_history')
      .select('channel_short_id, last_watched_at')
      .eq('user_id', user.id)
      .order('last_watched_at', { ascending: false })
      .limit(10);
    if (history) watchHistory = history;
  }

  return c.json({
    user: {
      username: user.username,
      is_verified: user.is_verified,
      avatar_url: user.avatar_url,
      created_at: user.created_at
    },
    stats: {
      followers: privacySettings.show_followers ? followersCount || 0 : null,
      following: privacySettings.show_following ? followingCount || 0 : null
    },
    privacy: privacySettings,
    watchHistory
  });
});

export default app;
