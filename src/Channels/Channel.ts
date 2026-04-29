import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { getShortId } from './Stream.js';
import axios from 'axios';

const router = new Hono();

// Memory cache for the current execution instance
const statusCache = new Map<string, { status: string, time: number }>();
const STATUS_TTL_MS = 15 * 60 * 1000; // 15 Minutes

/**
 * Fast Stream Status Checker
 */
async function checkStreamStatus(url: string): Promise<string> {
  if (!url) return 'offline';
  
  // 1. Check Instance Memory (Fastest)
  const cached = statusCache.get(url);
  if (cached && (Date.now() - cached.time) < STATUS_TTL_MS) return cached.status;

  try {
    // 2. Perform a very fast HEAD request (Max 1.5s timeout for Vercel stability)
    const res = await axios.head(url, { 
      timeout: 1500, 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTVCloud/1.0' },
      validateStatus: (status) => status >= 200 && status < 500
    });
    
    let status = 'offline';
    if (res.status === 403) status = 'geo-blocked';
    else if (res.status < 400) status = 'online';
    
    statusCache.set(url, { status, time: Date.now() });
    return status;
  } catch (err: any) {
    const status = err.response?.status === 403 ? 'geo-blocked' : 'offline';
    statusCache.set(url, { status, time: Date.now() });
    return status;
  }
}

/**
 * Optimized Channel Listing - Vercel & Performance Compatible
 */
router.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const search = c.req.query('search');
  const country = c.req.query('country');
  const category = c.req.query('category');
  const language = c.req.query('language');
  const statusFilter = c.req.query('status');

  try {
    // Fetch a bit more if we are filtering by online to account for potential drops
    const fetchLimit = statusFilter === 'online' ? limit + 10 : limit;
    
    let query = supabase
      .from('iptv_channels')
      .select(`
        *,
        iptv_streams (
          url,
          quality,
          status,
          last_checked_at
        )
      `)
      .range(offset, offset + fetchLimit - 1);

    if (search) query = query.or(`name.ilike.%${search}%,id.ilike.%${search}%`);
    if (country) query = query.eq('country', country.toUpperCase());
    if (category) query = query.contains('categories', [category]);
    if (language) query = query.contains('languages', [language]);

    const { data: channels, error } = await query;
    if (error) throw error;

    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const baseUrl = `${protocol}://${c.req.header('host')}`;
    const now = Date.now();

    const results = await Promise.all(
      (channels || []).map(async (ch: any) => {
        const streams = ch.iptv_streams || [];
        if (streams.length === 0) return null;

        const primary = streams[0];
        let currentStatus = primary.status;
        const lastChecked = primary.last_checked_at ? new Date(primary.last_checked_at).getTime() : 0;

        /**
         * Persistance Logic:
         * Only re-check if:
         * 1. Status is 'unknown'
         * 2. Status is older than 15 minutes AND we specifically need 'online' results
         */
        const isExpired = (now - lastChecked) > STATUS_TTL_MS;
        
        if (currentStatus === 'unknown' || (isExpired && statusFilter === 'online')) {
          currentStatus = await checkStreamStatus(primary.url);
          
          // Fire-and-forget DB update to keep response fast
          if (currentStatus !== primary.status || isExpired) {
            supabase
              .from('iptv_streams')
              .update({ status: currentStatus, last_checked_at: new Date().toISOString() })
              .eq('channel_id', ch.id)
              .eq('url', primary.url)
              .then(() => {})
              .catch(() => {});
          }
        }

        // Apply filtering logic
        if (statusFilter === 'online' && currentStatus !== 'online') return null;
        if (statusFilter && statusFilter !== 'online' && currentStatus !== statusFilter) return null;

        const shortId = await getShortId(ch.id);
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
          status: currentStatus,
          available_resolutions: streams.map((s: any) => s.quality).filter(Boolean),
          abr_supported: streams.length > 1
        };
      })
    );

    return c.json(results.filter(Boolean).slice(0, limit));
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
