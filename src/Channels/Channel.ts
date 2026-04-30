import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { getShortIds, checkStreamStatus } from './Utils.js';

const router = new Hono();

const DB_CACHE_TTL_MS = 10 * 60 * 1000; // 10 Minutes for API-level status trust

/**
 * Optimized Channel Listing - High Performance & Accurate
 */
router.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const search = c.req.query('search');
  const country = c.req.query('country');
  const category = c.req.query('category');
  const language = c.req.query('language');
  const statusFilter = c.req.query('status') || 'online'; // Default to online for better UX

  try {
    // Construct query with inner join to ensure only channels WITH streams are fetched
    let query = supabase
      .from('iptv_channels')
      .select(`
        *,
        iptv_streams!inner (
          url,
          quality,
          status,
          last_checked_at
        )
      `, { count: 'exact' });

    // Apply filters
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
    
    // Filter by status in DB first (optimized by update-channels tool)
    if (statusFilter && statusFilter !== 'all') {
      query = query.eq('iptv_streams.status', statusFilter);
    }

    const { data: channels, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('name', { ascending: true });

    if (error) throw error;

    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const baseUrl = `${protocol}://${c.req.header('host')}`;
    const now = Date.now();

    // 1. Bulk resolve Short IDs
    const originalIds = (channels || []).map((ch: any) => ch.id);
    const shortIdMap = await getShortIds(originalIds);

    // 2. Process results efficiently
    const results = await Promise.all(
      (channels || []).map(async (ch: any) => {
        const streams = ch.iptv_streams || [];
        if (streams.length === 0) return null;

        const primary = streams[0];
        let status = primary.status;
        const lastChecked = primary.last_checked_at ? new Date(primary.last_checked_at).getTime() : 0;
        const isExpired = (now - lastChecked) > DB_CACHE_TTL_MS;

        // Smart Update: Only re-check if unknown or really old
        if (status === 'unknown' || (status === 'online' && isExpired)) {
          const newStatus = await checkStreamStatus(primary.url);
          
          if (newStatus !== status) {
            status = newStatus;
            // Background update (don't wait)
            supabase
              .from('iptv_streams')
              .update({ status: newStatus, last_checked_at: new Date().toISOString() })
              .eq('channel_id', ch.id)
              .eq('url', primary.url)
              .then(() => {});
          }
        }

        // Post-fetch status filtering (if DB check wasn't enough or status changed)
        if (statusFilter && statusFilter !== 'all' && status !== statusFilter) return null;

        const shortId = shortIdMap[ch.id] || ch.id;
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
          status,
          available_resolutions: streams.map((s: any) => s.quality).filter(Boolean),
          abr_supported: streams.length > 1
        };
      })
    );

    const final = results.filter(Boolean);
    return c.json(final);
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
