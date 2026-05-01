import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { getCategoriesWithCache, getLanguagesWithCache } from './Utils.js';

const router = new Hono();

/**
 * Legacy IPTV Handlers - Redirected to database for performance
 */

router.get('/categories', async (c) => {
  try {
    const data = await getCategoriesWithCache();
    return c.json(data);
  } catch (err) {
    return c.json({ error: 'Failed to fetch categories' }, 500);
  }
});

router.get('/languages', async (c) => {
  try {
    const data = await getLanguagesWithCache();
    return c.json(data);
  } catch (err) {
    return c.json({ error: 'Failed to fetch languages' }, 500);
  }
});

router.get('/countries', async (c) => {
  const { data } = await supabase.from('iptv_countries').select('*').order('name');
  return c.json(data);
});

router.get('/streams', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  
  const { data } = await supabase
    .from('iptv_streams')
    .select('*')
    .range(offset, offset + limit - 1);
    
  return c.json(data);
});

router.get('/channels', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const { data } = await supabase
    .from('iptv_channels')
    .select('*')
    .range(offset, offset + limit - 1);

  return c.json(data);
});

export default router;
