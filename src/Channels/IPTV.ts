import { Hono } from 'hono';
import axios from 'axios';
import { checkStreamStatus } from './Utils.js';

const router = new Hono();

const BASE_URL = 'https://iptv-org.github.io/api';

// Cache configuration
const caches: Record<string, { data: any, lastLoad: number }> = {};
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getCachedData(endpoint: string) {
  const now = Date.now();
  if (caches[endpoint] && (now - caches[endpoint].lastLoad) < CACHE_TTL) {
    return caches[endpoint].data;
  }

  console.log(`[IPTV] Fetching ${endpoint}...`);
  try {
    const res = await axios.get(`${BASE_URL}/${endpoint}.json`);
    caches[endpoint] = { data: res.data, lastLoad: now };
    return res.data;
  } catch (err) {
    console.error(`[IPTV] Failed to fetch ${endpoint}:`, err);
    if (caches[endpoint]) return caches[endpoint].data;
    throw err;
  }
}

/**
 * All API Handlers from iptv-org
 */

router.get('/categories', async (c) => c.json(await getCachedData('categories')));
router.get('/languages', async (c) => c.json(await getCachedData('languages')));
router.get('/countries', async (c) => c.json(await getCachedData('countries')));
router.get('/regions', async (c) => c.json(await getCachedData('regions')));
router.get('/subdivisions', async (c) => c.json(await getCachedData('subdivisions')));
router.get('/cities', async (c) => c.json(await getCachedData('cities')));
router.get('/timezones', async (c) => c.json(await getCachedData('timezones')));
router.get('/blocklist', async (c) => c.json(await getCachedData('blocklist')));
router.get('/feeds', async (c) => c.json(await getCachedData('feeds')));
router.get('/logos', async (c) => c.json(await getCachedData('logos')));

router.get('/streams', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 50); // Hard limit for stability
  const offset = parseInt(c.req.query('offset') || '0', 10);
  
  try {
    const data = await getCachedData('streams');
    const slice = data.slice(offset, offset + limit);

    // Perform parallel status detection using consolidated utility
    const results = await Promise.all(slice.map(async (s: any) => {
      const status = await checkStreamStatus(s.url);
      return {
        ...s,
        status: status
      };
    }));

    return c.json(results);
  } catch (error) {
    return c.json({ error: 'Failed to fetch streams' }, 500);
  }
});

router.get('/channels', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const data = await getCachedData('channels');
  return c.json(data.slice(0, limit));
});

router.get('/guides', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const data = await getCachedData('guides');
  return c.json(data.slice(0, limit));
});

export default router;
