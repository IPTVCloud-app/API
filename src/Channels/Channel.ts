import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { getShortId } from './Stream.js';
import axios from 'axios';

const router = new Hono();

// Memory cache for the current execution instance (ephemeral)
const statusCache = new Map<string, { status: string, time: number }>();
const DB_CACHE_TTL_MS = 1 * 60 * 1000; // 1 Minute for database persistence
const AXIOS_TIMEOUT = 2000; // 2 seconds for Vercel stability

/**
 * High-Performance Stream Status Checker
 * 1. Tries HEAD request (no content download)
 * 2. Falls back to minimal GET (byte-range) if HEAD is blocked
 */
async function checkStreamStatus(url: string): Promise<string> {
  if (!url) return 'offline';
  
  // Instance Memory Check (Speed)
  const cached = statusCache.get(url);
  if (cached && (Date.now() - cached.time) < DB_CACHE_TTL_MS) return cached.status;

  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTVCloud/1.0',
    'Range': 'bytes=0-0' // Request only first byte to prevent download
  };

  try {
    // Phase 1: Try HEAD (Fastest, no body)
    const headRes = await axios.head(url, { 
      timeout: AXIOS_TIMEOUT, 
      headers,
      validateStatus: (status) => status >= 200 && status < 500
    });
    
    if (headRes.status < 400) return 'online';
    if (headRes.status === 403) return 'geo-blocked';

    // Phase 2: Fallback to small GET (some servers block HEAD)
    const getRes = await axios.get(url, { 
      timeout: AXIOS_TIMEOUT, 
      headers,
      responseType: 'stream', // Don't download full body
      validateStatus: (status) => status >= 200 && status < 500
    });

    // Close stream immediately to prevent download
    if (getRes.data?.destroy) getRes.data.destroy();

    if (getRes.status < 400) return 'online';
    if (getRes.status === 403) return 'geo-blocked';
    
    return 'offline';
  } catch (err: any) {
    if (err.response?.status === 403) return 'geo-blocked';
    return 'offline';
  }
}

/**
 * Optimized Channel Listing - Vercel Serverless Compatible
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
    // Over-fetch slightly to fulfill limit after status filtering
    const fetchLimit = statusFilter === 'online' ? limit + 15 : limit;
    
    // Construct query
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
    const now = Date.now();

    const results = await Promise.all(
      (channels || []).map(async (ch: any) => {
        const streams = ch.iptv_streams || [];
        if (streams.length === 0) return null;

        const primary = streams[0];
        let status = primary.status;
        const lastChecked = primary.last_checked_at ? new Date(primary.last_checked_at).getTime() : 0;
        const isExpired = (now - lastChecked) > DB_CACHE_TTL_MS;

        // Smart Update: Only re-check if unknown, expired, or online filter requested
        if (status === 'unknown' || isExpired || statusFilter === 'online') {
          const newStatus = await checkStreamStatus(primary.url);
          
          // Asynchronous DB Update (Fire-and-forget for Vercel speed)
          if (newStatus !== status || isExpired) {
            status = newStatus;
            supabase
              .from('iptv_streams')
              .update({ status: newStatus, last_checked_at: new Date().toISOString() })
              .eq('channel_id', ch.id)
              .eq('url', primary.url)
              .then(() => {});
          }
        }

        // Apply dynamic status filtering
        if (statusFilter === 'online' && status !== 'online') return null;
        if (statusFilter && statusFilter !== 'online' && status !== statusFilter) return null;

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
          status,
          available_resolutions: streams.map((s: any) => s.quality).filter(Boolean),
          abr_supported: streams.length > 1
        };
      })
    );

    const final = results.filter(Boolean).slice(0, limit);
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
