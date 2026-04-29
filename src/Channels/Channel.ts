import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { getShortId } from './Stream.js';

const router = new Hono();

/**
 * Optimized Channel Listing using Supabase SQL filtering
 */
router.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const search = c.req.query('search');
  const country = c.req.query('country');
  const category = c.req.query('category');
  const language = c.req.query('language');
  const status = c.req.query('status');

  try {
    let query = supabase
      .from('iptv_channels')
      .select(`
        *,
        iptv_streams (
          url,
          quality,
          status,
          user_agent
        )
      `)
      .range(offset, offset + limit - 1);

    // 1. Apply Filters
    if (search) {
      query = query.or(`name.ilike.%${search}%,id.ilike.%${search}%`);
    }
    if (country) {
      query = query.eq('country', country.toUpperCase());
    }
    if (category) {
      query = query.contains('categories', [category]);
    }
    if (language) {
      query = query.contains('languages', [language]);
    }

    const { data: channels, error } = await query;
    if (error) throw error;

    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const baseUrl = `${protocol}://${c.req.header('host')}`;

    // 2. Format Results
    const results = await Promise.all(
      (channels || []).map(async (ch: any) => {
        const shortId = await getShortId(ch.id);
        
        // Filter streams by status if requested
        let streams = ch.iptv_streams || [];
        if (status) {
          streams = streams.filter((s: any) => s.status === status);
          if (streams.length === 0 && status === 'online') return null; // Skip if no online streams
        }

        const primaryStream = streams[0];

        return {
          id: shortId,
          original_id: ch.id,
          name: ch.name,
          logo: ch.logo,
          country: ch.country,
          subdivision: ch.subdivision,
          city: ch.city,
          categories: ch.categories,
          languages: ch.languages,
          stream: `${baseUrl}/api/channels/stream?id=${shortId}`,
          thumbnail: `${baseUrl}/api/channels/thumbnail?id=${shortId}`,
          status: primaryStream?.status || 'unknown',
          available_resolutions: streams.map((s: any) => s.quality).filter(Boolean),
          abr_supported: streams.length > 1
        };
      })
    );

    return c.json(results.filter(Boolean));
  } catch (error) {
    console.error('[Channel List Error]', error);
    return c.json({ error: 'Failed to fetch channels' }, 500);
  }
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.redirect(`/api/channels/stream?id=${id}`);
});

export default router;
