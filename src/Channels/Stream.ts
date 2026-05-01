import { Hono } from 'hono';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptvcloud-app.github.io/EPG/streams.json';

const STREAM_TTL = 1000 * 60 * 60;
const MANIFEST_TTL = 3000;
const SEGMENT_TTL = 1000 * 30; // 30s segment cache (critical)
const MAX_MANIFEST_CACHE_ENTRIES = 120;
const MAX_SEGMENT_CACHE_ENTRIES = 800;

type StreamVariant = {
  url: string;
  quality?: string;
};

type StreamIndex = Map<string, StreamVariant[]>;

type SegmentPayload = {
  data: ArrayBuffer;
  type: string;
};

type TimedManifest = {
  content: string;
  ts: number;
};

type TimedSegment = SegmentPayload & {
  ts: number;
};

// -------------------------
// STREAM INDEX
// -------------------------
let streamIndex: StreamIndex | null = null;
let lastLoad = 0;
let loadingPromise: Promise<StreamIndex> | null = null;

const idCache = new Map<string, string>();

// -------------------------
// SEGMENT CACHE + IN-FLIGHT DEDUPE
// -------------------------
const manifestCache = new Map<string, TimedManifest>();
const inflightManifests = new Map<string, Promise<string>>();

const segmentCache = new Map<string, TimedSegment>();
const inflightSegments = new Map<string, Promise<SegmentPayload>>();

function trimCache(cache: Map<string, unknown>, maxEntries: number) {
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

// -------------------------
// STREAM INDEX LOADER
// -------------------------
async function getStreamIndex() {
  const now = Date.now();

  if (streamIndex && now - lastLoad < STREAM_TTL) return streamIndex;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const res = await fetch(STREAMS_URL, {
        signal: AbortSignal.timeout(8000),
      });

      const data = await res.json();
      const streams = Array.isArray(data) ? data : data.streams || [];

      const map: StreamIndex = new Map();

      for (const s of streams) {
        if (!s.channel || !s.url) continue;
        if (!map.has(s.channel)) map.set(s.channel, []);
        map.get(s.channel)!.push({ url: s.url, quality: s.quality });
      }

      streamIndex = map;
      lastLoad = Date.now();

      return map;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

// -------------------------
// ID CACHE
// -------------------------
async function cachedOriginalId(id: string) {
  if (idCache.has(id)) return idCache.get(id)!;

  const val = await getOriginalId(id);
  idCache.set(id, val);
  return val;
}

// -------------------------
// SEGMENT FETCH (CRITICAL OPTIMIZATION)
// -------------------------
async function fetchSegment(url: string) {
  const now = Date.now();

  // cache hit
  const cached = segmentCache.get(url);
  if (cached && now - cached.ts < SEGMENT_TTL) {
    return cached;
  }
  if (cached && now - cached.ts >= SEGMENT_TTL) segmentCache.delete(url);

  // in-flight dedupe
  if (inflightSegments.has(url)) {
    return inflightSegments.get(url)!;
  }

  const promise: Promise<SegmentPayload> = (async () => {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) throw new Error(`Segment ${res.status}`);

    const data = await res.arrayBuffer();

    const type = res.headers.get('Content-Type') || 'video/MP2T';

    segmentCache.set(url, {
      data,
      type,
      ts: Date.now(),
    });
    trimCache(segmentCache, MAX_SEGMENT_CACHE_ENTRIES);

    return { data, type };
  })();

  inflightSegments.set(url, promise);

  try {
    return await promise;
  } finally {
    inflightSegments.delete(url);
  }
}

async function fetchManifest(url: string, channelId: string) {
  const cacheKey = `${channelId}:${url}`;
  const now = Date.now();
  const cached = manifestCache.get(cacheKey);
  if (cached && now - cached.ts < MANIFEST_TTL) {
    return cached.content;
  }
  if (cached && now - cached.ts >= MANIFEST_TTL) manifestCache.delete(cacheKey);

  const inflight = inflightManifests.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
    });

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

// -------------------------
// MANIFEST REWRITE (FAST)
// -------------------------
function rewriteManifest(content: string, baseUrl: string, channelId: string) {
  const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const lines = content.split('\n');

  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();

    if (!t || t.startsWith('#')) {
      out.push(line);
      continue;
    }

    let abs = t;

    if (!t.startsWith('http')) {
      try {
        abs = new URL(t, base).href;
      } catch {
        out.push(line);
        continue;
      }
    }

    out.push(
      `/api/channels/stream?id=${channelId}&segment=${encodeURIComponent(abs)}`
    );
  }

  return out.join('\n');
}

// -------------------------
// ROUTE
// -------------------------
router.get('/', async (c) => {
  const id = c.req.query('id');
  const segment = c.req.query('segment');
  const resParam = c.req.query('res');

  if (!id) return c.json({ error: 'Missing id' }, 400);

  let targetUrl: string | undefined;
  if (segment) {
    try {
      targetUrl = decodeURIComponent(segment);
    } catch {
      return c.json({ error: 'Invalid segment URL' }, 400);
    }
  } else {
    const originalId = await cachedOriginalId(id);
    const streams = await getStreamIndex();
    const list = streams.get(originalId);
    targetUrl = list?.[0]?.url;

    if (resParam && list) {
      const match = list.find((s) => s.quality === resParam || (s.quality && s.quality.includes(resParam)));
      if (match) targetUrl = match.url;
    }
  }

  if (!targetUrl) return c.json({ error: 'Stream not found' }, 404);

  const isManifest = targetUrl.includes('.m3u8');

  // -------------------------
  // MANIFEST
  // -------------------------
  if (isManifest) {
    try {
      const rewritten = await fetchManifest(targetUrl, id);

      return new Response(rewritten, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=3',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return c.json({ error: 'manifest fail' }, 502);
    }
  }

  // -------------------------
  // SEGMENT (OPTIMIZED PATH)
  // -------------------------
  try {
    const seg = await fetchSegment(targetUrl);

    return new Response(seg.data, {
      headers: {
        'Content-Type': seg.type,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes',
      },
    });

  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown';
    return c.json(
      { error: 'segment failed', detail },
      502
    );
  }
});

export default router;
