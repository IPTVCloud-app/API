import { Hono } from 'hono';
import axios from 'axios';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

/* -------------------------------------------------------
   STREAM INDEX CACHE
------------------------------------------------------- */
let streamIndex: Map<string, any[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60;

const QUALITY_WEIGHTS: Record<string, number> = {
  '1080p': 100,
  '720p': 80,
  '540p': 60,
  '480p': 40,
  'SD': 20
};

function getQualityWeight(q: string) {
  return QUALITY_WEIGHTS[q] || 10;
}

function isQualityTooHigh(q: string) {
  return getQualityWeight(q) > 100;
}

export async function getStreamIndex() {
  const now = Date.now();

  if (streamIndex && now - lastIndexLoad < INDEX_TTL) {
    return streamIndex;
  }

  const map = new Map<string, any[]>();

  try {
    const { data } = await axios.get(STREAMS_URL, { timeout: 10000 });

    data.forEach((s: any) => {
      if (!s.channel) return;

      const key = String(s.channel).toLowerCase();
      const arr = map.get(key) || [];

      arr.push({
        url: s.url,
        quality: s.quality || 'SD',
        user_agent: s.user_agent || null
      });

      map.set(key, arr);
    });

    for (const [k, arr] of map.entries()) {
      arr.sort(
        (a, b) => getQualityWeight(b.quality) - getQualityWeight(a.quality)
      );
      map.set(k, arr);
    }

    streamIndex = map;
    lastIndexLoad = now;

    return map;
  } catch {
    return streamIndex || new Map();
  }
}

/* -------------------------------------------------------
   HLS PROXY HELPERS
------------------------------------------------------- */

/**
 * Rewrites M3U8 content to proxy segments and sub-playlists through our server
 */
function rewriteM3U8(content: string, sourceUrl: string, proxyBase: string, ua: string) {
  const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#EXT-X-VERSION') || trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      return line;
    }
    
    // Rewrite URI attributes in tags (like EXT-X-KEY, EXT-X-MAP, etc.)
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, p1) => {
        const abs = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).href;
        return `URI="${proxyBase}?url=${encodeURIComponent(abs)}&ua=${encodeURIComponent(ua)}"`;
      });
    }

    // Rewrite segment or sub-playlist URLs
    const abs = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
    return `${proxyBase}?url=${encodeURIComponent(abs)}&ua=${encodeURIComponent(ua)}`;
  }).join('\n');
}

/* -------------------------------------------------------
   ROUTES
------------------------------------------------------- */

/**
 * Universal HLS Proxy Route
 * Proxies .m3u8, .ts, .key, etc.
 */
router.get('/proxy', async (c) => {
  const url = c.req.query('url');
  const ua = c.req.query('ua') || 'Mozilla/5.0';

  if (!url) return c.text('URL required', 400);

  const protocol = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host');
  const proxyBase = `${protocol}://${host}/api/channels/stream/proxy`;

  try {
    const isPlaylist = url.toLowerCase().includes('.m3u8');
    
    if (isPlaylist) {
      const { data } = await axios.get(url, { headers: { 'User-Agent': ua }, timeout: 10000 });
      const rewritten = rewriteM3U8(data, url, proxyBase, ua);
      
      return c.text(rewritten, 200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
    } else {
      // Proxy raw data (segments, keys, etc.)
      const res = await axios.get(url, { 
        responseType: 'stream', 
        headers: { 'User-Agent': ua },
        timeout: 15000 
      });

      const contentType = String(res.headers['content-type'] || 'application/octet-stream');
      
      return new Response(res.data, {
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }
  } catch (err) {
    return c.text('Proxy error', 502);
  }
});

/**
 * Entry point: /api/channels/stream?id=...
 */
router.get('/', async (c) => {
  const id = c.req.query('id');
  const res = c.req.query('res') || 'auto';

  if (!id) return c.json({ error: 'ID required' }, 400);

  try {
    const originalId = await getOriginalId(id);
    const searchId = (originalId || id).toLowerCase();

    const index = await getStreamIndex();
    const list = index.get(searchId) || [];

    if (!list.length) return c.json({ error: 'No streams found' }, 404);

    let allowed = list.filter((s: any) => !isQualityTooHigh(s.quality));
    if (!allowed.length) allowed = list;

    let selected = allowed[0];
    if (res !== 'auto') {
      const found = allowed.find((s: any) => s.quality === res);
      if (found) selected = found;
    }

    const ua = selected.user_agent || 'Mozilla/5.0';
    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const host = c.req.header('host');
    const proxyBase = `${protocol}://${host}/api/channels/stream/proxy`;

    // Fetch master playlist
    const { data } = await axios.get(selected.url, { 
      headers: { 'User-Agent': ua }, 
      timeout: 10000,
      responseType: 'text'
    });
    const rewritten = rewriteM3U8(data, selected.url, proxyBase, ua);

    return c.text(rewritten, 200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
  } catch (err) {
    return c.json({ error: 'Stream fail' }, 500);
  }
});

export default router;
