import { Hono } from 'hono';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = process.env.STREAMS_URL || 'https://iptvcloud-app.github.io/EPG/streams.json';
const STREAM_TTL = 1000 * 60 * 60;
const MANIFEST_TTL = 3000;
const MAX_MANIFEST_CACHE_ENTRIES = 120;

type StreamVariant = {
  url: string;
  quality?: string;
};

type StreamIndex = Map<string, StreamVariant[]>;

type TimedManifest = {
  content: string;
  ts: number;
};

let streamIndex: StreamIndex | null = null;
let lastLoad = 0;
let loadingPromise: Promise<StreamIndex> | null = null;
const idCache = new Map<string, string>();

const manifestCache = new Map<string, TimedManifest>();
const inflightManifests = new Map<string, Promise<string>>();

function trimCache(cache: Map<string, unknown>, maxEntries: number) {
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHlsManifest(url: string) {
  return /\.m3u8(?:$|\?)/i.test(url);
}

function normalizeStreamPayload(payload: unknown): StreamIndex {
  const dataObj = payload as { streams?: Array<{ channel?: string; url?: string; quality?: string }> };
  const streams = Array.isArray(payload) ? payload : dataObj?.streams || [];
  const map: StreamIndex = new Map();

  for (const s of streams) {
    if (!s?.channel || !s?.url) continue;
    if (!map.has(s.channel)) map.set(s.channel, []);
    map.get(s.channel)!.push({ url: s.url, quality: s.quality });
  }

  return map;
}

async function getStreamIndex() {
  const now = Date.now();

  if (streamIndex && now - lastLoad < STREAM_TTL) return streamIndex;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const res = await fetch(STREAMS_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`stream index ${res.status}`);
      const data = await res.json();
      const map = normalizeStreamPayload(data);
      streamIndex = map;
      lastLoad = Date.now();
      return map;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

async function cachedOriginalId(id: string) {
  if (idCache.has(id)) return idCache.get(id)!;
  const val = await getOriginalId(id);
  idCache.set(id, val);
  return val;
}

function pickVariant(list: StreamVariant[], resParam?: string | null, hlsOnly = false) {
  const candidates = hlsOnly ? list.filter((item) => isHlsManifest(item.url)) : list;
  if (candidates.length === 0) return undefined;

  if (resParam) {
    const match = candidates.find(
      (item) => item.quality === resParam || (item.quality && item.quality.includes(resParam))
    );
    if (match) return match;
  }

  const firstManifest = candidates.find((item) => isHlsManifest(item.url));
  return firstManifest || candidates[0];
}

function rewriteManifest(content: string, baseUrl: string, channelId: string) {
  const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const lines = content.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }

    let absolute = trimmed;
    if (!trimmed.startsWith('http')) {
      try {
        absolute = new URL(trimmed, base).href;
      } catch {
        out.push(line);
        continue;
      }
    }

    out.push(`/api/channels/stream?id=${channelId}&segment=${encodeURIComponent(absolute)}`);
  }

  return out.join('\n');
}

async function fetchManifest(url: string, channelId: string) {
  const cacheKey = `${channelId}:${url}`;
  const now = Date.now();

  const cached = manifestCache.get(cacheKey);
  if (cached && now - cached.ts < MANIFEST_TTL) return cached.content;
  if (cached && now - cached.ts >= MANIFEST_TTL) manifestCache.delete(cacheKey);

  const inflight = inflightManifests.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`manifest ${res.status}`);

    const text = await res.text();
    const rewritten = rewriteManifest(text, url, channelId);
    manifestCache.set(cacheKey, { content: rewritten, ts: Date.now() });
    trimCache(manifestCache, MAX_MANIFEST_CACHE_ENTRIES);
    return rewritten;
  })();

  inflightManifests.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    inflightManifests.delete(cacheKey);
  }
}

router.get('/meta', async (c) => {
  const id = c.req.query('id');
  const resParam = c.req.query('res');

  if (!id) return c.json({ error: 'Missing id' }, 400);

  const originalId = await cachedOriginalId(id);
  const streams = await getStreamIndex();
  const list = streams.get(originalId) || [];

  const selected = pickVariant(list, resParam, true);
  if (!selected) {
    return c.json(
      {
        error: 'HLS stream not found',
        hint: 'This channel does not currently expose an HLS manifest.',
      },
      404
    );
  }

  const qualityOptions = list
    .filter((item) => isHlsManifest(item.url))
    .map((item) => item.quality)
    .filter((q): q is string => Boolean(q))
    .filter((q, idx, arr) => arr.indexOf(q) === idx);

  return c.json({
    channelId: id,
    originalId,
    protocol: 'hls',
    manifestUrl: `/api/channels/stream?id=${id}${resParam ? `&res=${encodeURIComponent(resParam)}` : ''}`,
    sourceUrl: selected.url,
    abrSupported: qualityOptions.length > 1,
    qualities: qualityOptions,
  });
});

router.get('/', async (c) => {
  const id = c.req.query('id');
  const segment = c.req.query('segment');
  const source = c.req.query('source');
  const resParam = c.req.query('res');

  if (!id) return c.json({ error: 'Missing id' }, 400);

  let targetUrl: string | undefined;

  if (segment) {
    try {
      targetUrl = decodeURIComponent(segment);
    } catch {
      return c.json({ error: 'Invalid segment URL' }, 400);
    }
  } else if (source) {
    try {
      targetUrl = decodeURIComponent(source);
    } catch {
      return c.json({ error: 'Invalid source URL' }, 400);
    }
  } else {
    const originalId = await cachedOriginalId(id);
    const streams = await getStreamIndex();
    const list = streams.get(originalId) || [];
    const selected = pickVariant(list, resParam, true);
    targetUrl = selected?.url;
  }

  if (!targetUrl) return c.json({ error: 'Stream not found' }, 404);
  if (!isHttpUrl(targetUrl)) return c.json({ error: 'Invalid target url' }, 400);

  const isManifest = isHlsManifest(targetUrl);

  if (isManifest) {
    try {
      const rewritten = await fetchManifest(targetUrl, id);
      return new Response(rewritten, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          // Vercel Edge Cache for Manifests: 
          // max-age=0 (browser doesn't cache)
          // s-maxage=2 (Edge caches for 2s)
          // stale-while-revalidate=2 (Serve stale instantly, update in background)
          'Cache-Control': 'public, max-age=0, s-maxage=2, stale-while-revalidate=2',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return c.json({ error: 'manifest fail' }, 502);
    }
  }

  try {
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) throw new Error(`segment ${res.status}`);

    const type = res.headers.get('Content-Type') || 'video/MP2T';

    // Direct Stream Piping (Zero-Copy) using Vercel Edge Cache for Segments
    return new Response(res.body, {
      headers: {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        // Vercel Edge Cache for Segments:
        // max-age=3600 (browser caches for 1hr)
        // s-maxage=31536000 (Edge caches for 1 year, segments are immutable)
        'Cache-Control': 'public, max-age=3600, s-maxage=31536000, stale-while-revalidate=86400',
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown';
    return c.json({ error: 'segment failed', detail }, 502);
  }
});

export default router;
