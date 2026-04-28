import { Hono, Context } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
// @ts-expect-error mux.js does not have official types
import muxjs from 'mux.js';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

/* -------------------------------------------------------
   TYPES & INTERFACES
------------------------------------------------------- */
interface StreamSource {
  url: string;
  quality: string;
  user_agent: string | null;
  channel?: string;
}

interface MuxEvent {
  initSegment?: Uint8Array;
  data?: Uint8Array;
}

interface MuxjsTransmuxer {
  push(data: Uint8Array): void;
  flush(): void;
  dispose(): void;
  on(event: string, callback: (data: MuxEvent) => void): void;
}

interface MuxjsNamespace {
  mp4: {
    Transmuxer: new (options: { keepOriginalTimestamps: boolean }) => MuxjsTransmuxer;
  };
}

/* -------------------------------------------------------
   STREAM INDEX (FAST CACHE)
------------------------------------------------------- */
let streamIndex: Map<string, StreamSource[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 3600000;

const QUALITY_WEIGHTS: Record<string, number> = { '1080p': 100, '720p': 80, '540p': 60, '480p': 40, 'SD': 20 };
const getQualityWeight = (q: string) => QUALITY_WEIGHTS[q] || 10;
const isQualityTooHigh = (q: string) => getQualityWeight(q) > 100;

export async function getStreamIndex(): Promise<Map<string, StreamSource[]>> {
  const now = Date.now();
  if (streamIndex && now - lastIndexLoad < INDEX_TTL) return streamIndex;

  try {
    const { data } = await axios.get<StreamSource[]>(STREAMS_URL, { timeout: 10000 });
    const map = new Map<string, StreamSource[]>();
    data.forEach((s) => {
      if (!s.channel) return;
      const key = String(s.channel).toLowerCase();
      const arr = map.get(key) || [];
      arr.push({ url: s.url, quality: s.quality || 'SD', user_agent: s.user_agent || null });
      map.set(key, arr);
    });
    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => getQualityWeight(b.quality) - getQualityWeight(a.quality));
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
   CONTINUOUS fMP4 RELAY ENGINE (MSE COMPATIBLE)
------------------------------------------------------- */

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function relayStream(c: Context, sourceUrl: string, ua: string) {
  // 1. PRE-FETCH MANIFEST TO AVOID "WAITING FOR RESPONSE"
  let initialManifest: string;
  const referer = new URL(sourceUrl).origin;
  try {
    const res = await fetchWithTimeout(sourceUrl, {
      headers: { 'User-Agent': ua, 'Referer': referer }
    }, 5000);
    if (!res.ok) throw new Error();
    initialManifest = await res.text();
  } catch {
    throw new HTTPException(502, { message: 'Failed to fetch stream manifest' });
  }

  // 2. SET STABLE RESPONSE HEADERS (VERCEL OPTIMIZED)
  c.header('Content-Type', 'video/mp4');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Connection', 'keep-alive');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Accel-Buffering', 'no'); // Disable buffering on Vercel/Nginx

  return stream(c, async (streamInstance) => {
    const transmuxer = new (muxjs as unknown as MuxjsNamespace).mp4.Transmuxer({
      keepOriginalTimestamps: true,
    });

    let initSent = false;
    let isActive = true;
    let dataQueue: MuxEvent[] = [];
    const seenSegments = new Set<string>();
    const prefetchMap = new Map<string, Promise<ArrayBuffer | null>>();
    const MAX_PREFETCH = 3;

    transmuxer.on('data', (event: MuxEvent) => {
      dataQueue.push(event);
    });

    streamInstance.onAbort(() => {
      isActive = false;
    });

    let currentManifest = initialManifest;

    try {
      while (isActive) {
        if (!currentManifest) {
          try {
            const res = await fetchWithTimeout(sourceUrl, {
              headers: { 'User-Agent': ua, 'Referer': referer }
            }, 5000);
            if (res.ok) currentManifest = await res.text();
          } catch { /* Retry in next loop */ }
        }

        if (!currentManifest) {
          if (isActive) await streamInstance.sleep(2000);
          continue;
        }

        const lines = currentManifest.split('\n');
        const segmentUrls: string[] = [];
        let targetDuration = 5;

        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = parseInt(t.split(':')[1]) || 5;
          }
          if (t && !t.startsWith('#')) {
            try {
              segmentUrls.push(new URL(t, sourceUrl).href);
            } catch { /* Skip */ }
          }
        }

        if (seenSegments.size === 0 && segmentUrls.length > 3) {
          segmentUrls.slice(0, -3).forEach(u => seenSegments.add(u));
        }

        for (const url of segmentUrls) {
          if (!isActive) break;
          if (seenSegments.has(url)) continue;

          // Sequential Prefetch
          const currentIdx = segmentUrls.indexOf(url);
          for (let i = 1; i <= MAX_PREFETCH; i++) {
            const nextUrl = segmentUrls[currentIdx + i];
            if (nextUrl && !seenSegments.has(nextUrl) && !prefetchMap.has(nextUrl)) {
              prefetchMap.set(nextUrl, fetchWithTimeout(nextUrl, {
                headers: { 'User-Agent': ua, 'Referer': referer }
              }, 15000).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null));
            }
          }

          let tsBuffer: ArrayBuffer | null = null;
          if (prefetchMap.has(url)) {
            tsBuffer = await prefetchMap.get(url)!;
            prefetchMap.delete(url);
          } else {
            try {
              const res = await fetchWithTimeout(url, {
                headers: { 'User-Agent': ua, 'Referer': referer }
              }, 15000);
              if (res.ok) tsBuffer = await res.arrayBuffer();
            } catch { /* Skip */ }
          }

          if (isActive && tsBuffer && tsBuffer.byteLength > 0) {
            transmuxer.push(new Uint8Array(tsBuffer));
            transmuxer.flush();

            while (dataQueue.length > 0) {
              const event = dataQueue.shift();
              if (!event) break;
              if (event.initSegment && !initSent) {
                await streamInstance.write(event.initSegment);
                initSent = true;
              }
              if (event.data) {
                await streamInstance.write(event.data);
              }
            }
          }

          seenSegments.add(url);
          if (seenSegments.size > 100) {
            const first = seenSegments.values().next().value;
            if (first) seenSegments.delete(first);
          }
        }

        currentManifest = ''; // Force refresh in next loop
        if (isActive) {
          await streamInstance.sleep((targetDuration * 1000) / 2);
        }
      }
    } catch {
      /* Aborted or Error */
    } finally {
      transmuxer.dispose();
      dataQueue = [];
      prefetchMap.clear();
    }
  });
}

/**
 * Entry Point: /api/channels/stream?id=...&res=...
 */
router.get('/', async (c) => {
  const id = c.req.query('id');
  const res = c.req.query('res') || 'auto';

  if (!id) throw new HTTPException(400, { message: 'ID required' });

  const originalId = await getOriginalId(id);
  const searchId = (originalId || id).toLowerCase();

  const index = await getStreamIndex();
  const list = index.get(searchId) || [];

  if (!list.length) throw new HTTPException(404, { message: 'Stream not found' });

  let allowed = list.filter((s) => !isQualityTooHigh(s.quality));
  if (!allowed.length) allowed = list;

  let selected = allowed[0];
  if (res !== 'auto') {
    const found = allowed.find((s) => s.quality === res);
    if (found) selected = found;
  }

  return relayStream(c, selected.url, selected.user_agent || 'Mozilla/5.0');
});

export default router;
