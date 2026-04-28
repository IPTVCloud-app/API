import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';

const router = new Hono<{ Variables: { user: any } }>();

router.use('*', authMiddleware);

// Get user's playlists
router.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const { data, error } = await supabase
      .from('playlists')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return c.json(data);
  } catch (error: any) {
    console.error('Error fetching playlists:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Create a new playlist
router.post('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json();
  const { name, description, is_public } = body;

  if (!name) return c.json({ error: 'Playlist name is required' }, 400);

  try {
    const { data, error } = await supabase
      .from('playlists')
      .insert([{ 
        user_id: user.id, 
        name, 
        description, 
        is_public: is_public || false 
      }])
      .select()
      .single();

    if (error) throw error;
    return c.json(data);
  } catch (error: any) {
    console.error('Error creating playlist:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Get a specific playlist and its items
router.get('/:id', async (c) => {
  const user = c.get('user');
  const playlistId = c.req.param('id');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    // 1. Get playlist details
    const { data: playlist, error: playlistError } = await supabase
      .from('playlists')
      .select('*')
      .eq('id', playlistId)
      .single();

    if (playlistError) throw playlistError;

    // Security check: Only owner or if public
    if (playlist.user_id !== user.id && !playlist.is_public) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // 2. Get items
    const { data: items, error: itemsError } = await supabase
      .from('playlist_items')
      .select('*, channel_mappings!inner(original_id, short_id)')
      .eq('playlist_id', playlistId)
      .order('position_order', { ascending: true })
      .order('added_at', { ascending: false });

    if (itemsError) throw itemsError;

    return c.json({ ...playlist, items });
  } catch (error: any) {
    console.error('Error fetching playlist:', error);
    return c.json({ error: 'Playlist not found or error fetching items' }, 404);
  }
});

// Update playlist details
router.put('/:id', async (c) => {
  const user = c.get('user');
  const playlistId = c.req.param('id');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json();
  const { name, description, is_public } = body;

  try {
    // Security check
    const { data: existing } = await supabase.from('playlists').select('user_id').eq('id', playlistId).single();
    if (existing?.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

    const { data, error } = await supabase
      .from('playlists')
      .update({ name, description, is_public, updated_at: new Date().toISOString() })
      .eq('id', playlistId)
      .select()
      .single();

    if (error) throw error;
    return c.json(data);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Delete a playlist
router.delete('/:id', async (c) => {
  const user = c.get('user');
  const playlistId = c.req.param('id');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    // Security check
    const { data: existing } = await supabase.from('playlists').select('user_id').eq('id', playlistId).single();
    if (existing?.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

    const { error } = await supabase.from('playlists').delete().eq('id', playlistId);
    if (error) throw error;

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Add a channel to playlist
router.post('/:id/items', async (c) => {
  const user = c.get('user');
  const playlistId = c.req.param('id');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json();
  const { channel_short_id } = body;

  if (!channel_short_id) return c.json({ error: 'channel_short_id is required' }, 400);

  try {
    // Security check
    const { data: existing } = await supabase.from('playlists').select('user_id').eq('id', playlistId).single();
    if (existing?.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

    // Get current max position
    const { data: maxPosItem } = await supabase
        .from('playlist_items')
        .select('position_order')
        .eq('playlist_id', playlistId)
        .order('position_order', { ascending: false })
        .limit(1)
        .single();
    
    const nextPosition = maxPosItem ? maxPosItem.position_order + 1 : 0;

    const { data, error } = await supabase
      .from('playlist_items')
      .insert([{ 
        playlist_id: playlistId, 
        channel_short_id,
        position_order: nextPosition 
      }])
      .select()
      .single();

    if (error) throw error;
    
    // Update playlist updated_at
    await supabase.from('playlists').update({ updated_at: new Date().toISOString() }).eq('id', playlistId);

    return c.json(data);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Remove a channel from playlist
router.delete('/:id/items/:channel_short_id', async (c) => {
  const user = c.get('user');
  const playlistId = c.req.param('id');
  const channelShortId = c.req.param('channel_short_id');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    // Security check
    const { data: existing } = await supabase.from('playlists').select('user_id').eq('id', playlistId).single();
    if (existing?.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

    const { error } = await supabase
      .from('playlist_items')
      .delete()
      .eq('playlist_id', playlistId)
      .eq('channel_short_id', channelShortId);
      
    if (error) throw error;

    // Update playlist updated_at
    await supabase.from('playlists').update({ updated_at: new Date().toISOString() }).eq('id', playlistId);

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default router;
