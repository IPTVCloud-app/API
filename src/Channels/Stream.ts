import { Hono } from 'hono';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptvcloud-app.github.io/EPG/streams.json';

const STREAM_TTL = 1000 * 60 * 60;
const MANIFEST_TTL = 3000;
const SEGMENT_TTL = 1000 * 30; // 30s segment cache (critical)

// -------------------------
// STREAM INDEX
// -------------------------
let streamIndex: Map<string, any[]> | null = null;
let lastLoad = 0;
let loadingPromise: Promise<Map<string, any[]>> | null = null;

const idCache = new Map<string, string>();

// -------------------------
// SEGMENT CACHE + IN-FLIGHT DEDUPE
// -------------------------
const segmentCache = new Map<string, { data: ArrayBuffer; type: string; ts: number }>();
const inflightSegments = new Map<string, Promise<{ data: ArrayBuffer; type: string }>>();

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

      const map = new Map<string, any[]>();

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

  // in-flight dedupe
  if (inflightSegments.has(url)) {
    return inflightSegments.get(url)!;
  }

  const promise = (async () => {
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

    return { data, type };
  })();

  inflightSegments.set(url, promise);

  try {
    return await promise;
  } finally {
    inflightSegments.delete(url);
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

  const originalId = await cachedOriginalId(id);
  const streams = await getStreamIndex();
  const list = streams.get(originalId);

  let targetUrl = list?.[0]?.url;

  if (resParam && list) {
    const match = list.find((s: any) => s.quality === resParam || (s.quality && s.quality.includes(resParam)));
    if (match) targetUrl = match.url;
  }

  if (segment) {
    targetUrl = decodeURIComponent(segment);
  }

  if (!targetUrl) return c.json({ error: 'Stream not found' }, 404);

  const isManifest = targetUrl.includes('.m3u8');

  // -------------------------
  // MANIFEST
  // -------------------------
  if (isManifest) {
    const res = await fetch(targetUrl, {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return c.json({ error: 'manifest fail' }, 502);

    const text = await res.text();
    const rewritten = rewriteManifest(text, targetUrl, id);

    return new Response(rewritten, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'public, max-age=3',
        'Access-Control-Allow-Origin': '*',
      },
    });
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

  } catch (err: any) {
    return c.json(
      { error: 'segment failed', detail: err.message },
      502
    );
  }
});

export default router;