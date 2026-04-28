import { Hono, Context } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
import { stream as honoStream } from 'hono/streaming';
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
  label?: string;
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
   STATUS CACHE & CHECK
------------------------------------------------------- */
const statusCache = new Map<string, { status: string, time: number }>();
const STATUS_TTL = 1000 * 60 * 5; // 5 minutes

async function checkStreamStatus(url: string, ua: string): Promise<string> {
  if (!url) return 'offline';
  const cached = statusCache.get(url);
  if (cached && (Date.now() - cached.time) < STATUS_TTL) return cached.status;

  try {
    const res = await fetch(url, { 
      method: 'HEAD',
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(2000)
    });
    
    let status = 'offline';
    if (res.status === 403) {
      status = 'geo-blocked';
    } else if (res.status < 400) {
      status = 'online';
    }
    
    statusCache.set(url, { status, time: Date.now() });
    return status;
  } catch {
    statusCache.set(url, { status: 'offline', time: Date.now() });
    return 'offline';
  }
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
      arr.push({ url: s.url, quality: s.quality || 'SD', user_agent: s.user_agent || null, label: s.label || null });
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
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function relayStream(c: Context, selected: StreamSource) {
  const sourceUrl = selected.url;
  const ua = selected.user_agent || 'Mozilla/5.0';
  const referer = new URL(sourceUrl).origin;

  // 1. Initial Status Check
  const status = await checkStreamStatus(sourceUrl, ua);
  if (status === 'geo-blocked') {
    throw new HTTPException(403, { 
      message: 'This stream is geo-blocked in your region/IP. Please use a VPN or try another channel.' 
    });
  }
  if (status === 'offline') throw new HTTPException(404, { message: 'Stream is offline' });

  // 2. Setup Headers (Instant Response)
  c.header('Content-Type', 'video/mp4');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Connection', 'keep-alive');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Accel-Buffering', 'no'); 

  // 3. Continuous fMP4 Streaming
  return honoStream(c, async (streamInstance) => {
    const transmuxer = new (muxjs as unknown as MuxjsNamespace).mp4.Transmuxer({
      keepOriginalTimestamps: true,
    });

    let initSent = false;
    let isActive = true;
    const seenSegments = new Set<string>();

    // Pattern: Capture fragments and write immediately
    transmuxer.on('data', async (event: MuxEvent) => {
      if (!initSent && event.initSegment) {
        await streamInstance.write(event.initSegment);
        initSent = true;
      }
      if (event.data) {
        await streamInstance.write(event.data);
      }
    });

    streamInstance.onAbort(() => {
      isActive = false;
      transmuxer.dispose();
    });

    try {
      while (isActive) {
        let manifest = '';
        try {
          const res = await fetchWithTimeout(sourceUrl, {
            headers: { 'User-Agent': ua, 'Referer': referer }
          }, 5000);
          if (res.ok) manifest = await res.text();
        } catch { /* Retry */ }

        if (!manifest) {
          if (isActive) await streamInstance.sleep(2000);
          continue;
        }

        const lines = manifest.split('\n');
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

        // Jump to live edge on initial load
        if (seenSegments.size === 0 && segmentUrls.length > 3) {
          segmentUrls.slice(0, -3).forEach(u => seenSegments.add(u));
        }

        for (const url of segmentUrls) {
          if (!isActive) break;
          if (seenSegments.has(url)) continue;

          try {
            const res = await fetchWithTimeout(url, {
              headers: { 'User-Agent': ua, 'Referer': referer }
            }, 10000);
            
            if (res.ok && isActive) {
              const tsBuffer = await res.arrayBuffer();
              // Pattern: Push and flush per segment
              transmuxer.push(new Uint8Array(tsBuffer));
              transmuxer.flush();
            }
          } catch { /* Skip corrupted segment */ }

          seenSegments.add(url);
          if (seenSegments.size > 50) {
            const first = seenSegments.values().next().value;
            if (first) seenSegments.delete(first);
          }
        }

        if (isActive) {
          await streamInstance.sleep((targetDuration * 1000) / 2);
        }
      }
    } catch {
      /* Silently close */
    } finally {
      transmuxer.dispose();
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

  return relayStream(c, selected);
});

export default router;
