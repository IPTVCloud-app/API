import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';

const router = new Hono();

router.use('*', authMiddleware);

const updateSettingsSchema = z.object({
  themeMode: z.enum(['light', 'dark', 'system']).optional(),
  themeAccent: z.string().optional(),
  playerResolution: z.enum(['default', '1080p', '720p', '480p']).optional(),
  playerCc: z.boolean().optional(),
});

/**
 * Get User Settings
 */
router.get('/', async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;

  try {
    const { data: settings, error } = await supabase
      .from('user_settings')
      .select('theme_mode, theme_accent, player_resolution, player_cc')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No settings exist yet, return defaults
        return c.json({
          theme_mode: 'system',
          theme_accent: '#5e6ad2',
          player_resolution: 'default',
          player_cc: false,
        }, 200);
      }
      throw error;
    }

    return c.json(settings, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Update User Settings
 */
router.put('/', zValidator('json', updateSettingsSchema), async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const data = c.req.valid('json');

  const updatePayload: any = {
    updated_at: new Date().toISOString(),
  };
  
  if (data.themeMode !== undefined) updatePayload.theme_mode = data.themeMode;
  if (data.themeAccent !== undefined) updatePayload.theme_accent = data.themeAccent;
  if (data.playerResolution !== undefined) updatePayload.player_resolution = data.playerResolution;
  if (data.playerCc !== undefined) updatePayload.player_cc = data.playerCc;

  try {
    // Upsert the settings
    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: userId, ...updatePayload }, { onConflict: 'user_id' });

    if (error) {
      throw error;
    }

    return c.json({ message: 'Settings updated successfully' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

export default router;
