import { Hono } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
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

/* -------------------------------------------------------
   SPEED CACHE (PLAYLIST + DVR)
------------------------------------------------------- */
const playlistCache = new Map<string, { data: string; time: number }>();
const PLAYLIST_TTL = 1000 * 3; // ultra-fast cache

const dvrCache = new Map<string, { playlist: string; time: number }>();
const DVR_WINDOW = 1000 * 60 * 5; // 5 minutes DVR buffer

/* -------------------------------------------------------
   STREAM INDEX
------------------------------------------------------- */
export async function getStreamIndex() {
  const now = Date.now();

  if (streamIndex && now - lastIndexLoad < INDEX_TTL) {
    return streamIndex;
  }

  const map = new Map<string, any[]>();

  try {
    const { data } = await axios.get(STREAMS_URL, { timeout: 15000 });

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
  } catch (err: any) {
    console.error('[StreamIndex] Failed:', err.message);
    return streamIndex || new Map();
  }
}

/* -------------------------------------------------------
   FAST PLAYLIST FETCH (IMPORTANT SPEED BOOST)
------------------------------------------------------- */
async function getCachedPlaylist(url: string, ua: string) {
  const now = Date.now();
  const cached = playlistCache.get(url);

  if (cached && now - cached.time < PLAYLIST_TTL) {
    return cached.data;
  }

  const res = await axios.get(url, {
    headers: { 'User-Agent': ua },
    timeout: 8000,
    responseType: 'text'
  });

  playlistCache.set(url, {
    data: res.data,
    time: now
  });

  return res.data;
}

/* -------------------------------------------------------
   M3U8 REWRITER
------------------------------------------------------- */
function rewriteM3U8(content: string, sourceUrl: string, proxyBase: string, ua: string) {
  const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);

  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, p1) => {
        const abs = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).href;
        return `URI="${proxyBase}?url=${encodeURIComponent(abs)}&ua=${encodeURIComponent(ua)}"`;
      });
    }

    const abs = trimmed.startsWith('http')
      ? trimmed
      : new URL(trimmed, baseUrl).href;

    return `${proxyBase}?url=${encodeURIComponent(abs)}&ua=${encodeURIComponent(ua)}`;
  }).join('\n');
}

/* -------------------------------------------------------
   UNIVERSAL PROXY (SEGMENTS / PLAYLISTS)
------------------------------------------------------- */
router.get('/proxy', async (c) => {
  const url = c.req.query('url');
  const ua = c.req.query('ua') || 'Mozilla/5.0';

  if (!url) {
    throw new HTTPException(400, { message: 'URL required' });
  }

  try {
    const isPlaylist = url.includes('.m3u8');

    if (isPlaylist) {
      const data = await getCachedPlaylist(url, ua);

      return c.text(data, 200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'public, max-age=2',
        'Access-Control-Allow-Origin': '*'
      });
    }

    const res = await axios.get(url, {
      responseType: 'stream',
      headers: { 'User-Agent': ua },
      timeout: 20000
    });

    return new Response(res.data, {
      headers: {
        'Content-Type': String(res.headers['content-type'] || 'application/octet-stream'),
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err: any) {
    throw new HTTPException(500, { message: err.message });
  }
});

/* -------------------------------------------------------
   MAIN STREAM ROUTE (FAST + DVR)
------------------------------------------------------- */
router.get('/', async (c) => {
  const id = c.req.query('id');
  const res = c.req.query('res') || 'auto';
  const dvr = c.req.query('dvr') === 'true';
  const fast = c.req.query('fast') === '1';

  if (!id) {
    throw new HTTPException(400, { message: 'Channel ID required' });
  }

  const originalId = await getOriginalId(id);
  const searchId = (originalId || id).toLowerCase();

  const index = await getStreamIndex();
  const list = index.get(searchId) || [];

  if (!list.length) {
    throw new HTTPException(404, { message: 'No streams found' });
  }

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

  const raw = await getCachedPlaylist(selected.url, ua);
  const rewritten = rewriteM3U8(raw, selected.url, proxyBase, ua);

  const cacheKey = `${searchId}:${selected.url}`;
  const now = Date.now();

  /* ---------------- DVR BUFFER ---------------- */
  dvrCache.set(cacheKey, {
    playlist: rewritten,
    time: now
  });

  if (now - (dvrCache.get(cacheKey)?.time || 0) > DVR_WINDOW) {
    dvrCache.set(cacheKey, { playlist: rewritten, time: now });
  }

  /* ---------------- FAST MODE ---------------- */
  if (fast) {
    return c.text(raw, 200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=1',
      'X-Fast-Mode': 'true'
    });
  }

  /* ---------------- DVR MODE ---------------- */
  if (dvr) {
    const cached = dvrCache.get(cacheKey);

    if (cached) {
      return c.text(cached.playlist, 200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
        'X-DVR-Mode': 'true'
      });
    }
  }

  return c.text(rewritten, 200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'X-Stream-Mode': 'normal'
  });
});

export default router;