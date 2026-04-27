import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';

const router = new Hono();

router.use('*', authMiddleware);

const updatePrivacySchema = z.object({
  showFollowers: z.boolean().optional(),
  showFollowing: z.boolean().optional(),
  showWatchHistory: z.boolean().optional(),
  showComments: z.boolean().optional(),
});

/**
 * Get User Privacy Settings
 */
router.get('/', async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;

  try {
    const { data: privacy, error } = await supabase
      .from('user_privacy')
      .select('show_followers, show_following, show_watch_history, show_comments')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No privacy settings exist yet, return defaults
        return c.json({
          show_followers: true,
          show_following: true,
          show_watch_history: true,
          show_comments: true,
        }, 200);
      }
      throw error;
    }

    return c.json(privacy, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Update User Privacy Settings
 */
router.put('/', zValidator('json', updatePrivacySchema), async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const data = c.req.valid('json');

  const updatePayload: any = {
    updated_at: new Date().toISOString(),
  };
  
  if (data.showFollowers !== undefined) updatePayload.show_followers = data.showFollowers;
  if (data.showFollowing !== undefined) updatePayload.show_following = data.showFollowing;
  if (data.showWatchHistory !== undefined) updatePayload.show_watch_history = data.showWatchHistory;
  if (data.showComments !== undefined) updatePayload.show_comments = data.showComments;

  try {
    // Upsert the privacy settings
    const { error } = await supabase
      .from('user_privacy')
      .upsert({ user_id: userId, ...updatePayload }, { onConflict: 'user_id' });

    if (error) {
      throw error;
    }

    return c.json({ message: 'Privacy settings updated successfully' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

export default router;
