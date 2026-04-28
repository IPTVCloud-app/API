import { Hono, Context } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
import { stream as honoStream } from 'hono/streaming';
// @ts-expect-error mux.js has no official types
import muxjs from 'mux.js';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

/* -------------------------------------------------------
   TYPES
------------------------------------------------------- */
interface StreamSource {
  url: string;
  quality: string;
  user_agent: string | null;
  channel?: string;
  label?: string | null;
}

/* -------------------------------------------------------
   QUALITY FILTER
------------------------------------------------------- */
const QUALITY_WEIGHTS: Record<string, number> = {
  '1080p': 100,
  '720p': 80,
  '540p': 60,
  '480p': 40,
  'SD': 20
};

const getQualityWeight = (q: string) => QUALITY_WEIGHTS[q] || 10;
const isQualityTooHigh = (q: string) => getQualityWeight(q) > 100;

/* -------------------------------------------------------
   STREAM INDEX (UNCHANGED - STABLE)
------------------------------------------------------- */
let streamIndex: Map<string, StreamSource[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60;

export async function getStreamIndex(): Promise<Map<string, StreamSource[]>> {
  const now = Date.now();
  if (streamIndex && now - lastIndexLoad < INDEX_TTL) return streamIndex;

  try {
    const { data } = await axios.get<StreamSource[]>(STREAMS_URL, { timeout: 10000 });

    const map = new Map<string, StreamSource[]>();

    for (const s of data) {
      if (!s.channel || !s.url) continue;

      const key = String(s.channel).toLowerCase();
      const list = map.get(key) || [];

      list.push({
        url: s.url,
        quality: s.quality || 'SD',
        user_agent: s.user_agent || null,
        label: s.label || null
      });

      map.set(key, list);
    }

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
   STREAM STATUS (UNCHANGED)
------------------------------------------------------- */
const statusCache = new Map<string, { status: string; time: number }>();
const STATUS_TTL = 1000 * 60 * 5;

async function checkStreamStatus(url: string, ua: string): Promise<string> {
  if (!url) return 'offline';

  const cached = statusCache.get(url);
  if (cached && Date.now() - cached.time < STATUS_TTL) return cached.status;

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(2000)
    });

    let status = 'offline';
    if (res.status === 403) status = 'geo-blocked';
    else if (res.status < 400) status = 'online';

    statusCache.set(url, { status, time: Date.now() });
    return status;

  } catch {
    statusCache.set(url, { status: 'offline', time: Date.now() });
    return 'offline';
  }
}

/* -------------------------------------------------------
   FETCH WITH TIMEOUT
------------------------------------------------------- */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/* -------------------------------------------------------
   🔥 FIXED RELAY ENGINE (YOUR WORKING VERSION INTEGRATED)
------------------------------------------------------- */
async function relayStream(c: Context, selected: StreamSource) {
  const ua = selected.user_agent || 'Mozilla/5.0';
  const referer = new URL(selected.url).origin;

  const status = await checkStreamStatus(selected.url, ua);

  if (status === 'geo-blocked') {
    throw new HTTPException(403, {
      message: 'Stream is geo-blocked. Use VPN or another source.'
    });
  }

  if (status === 'offline') {
    throw new HTTPException(404, { message: 'Stream offline' });
  }

  c.header('Content-Type', 'video/mp4');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return honoStream(c, async (stream) => {
    const Transmuxer = (muxjs as any).mp4.Transmuxer;

    const transmuxer = new Transmuxer({
      keepOriginalTimestamps: true,
      baseMediaDecodeTime: 0
    });

    let initSent = false;
    let active = true;
    const seenSegments = new Set<string>();

    transmuxer.on('data', async (ev: any) => {
      if (!initSent && ev.initSegment) {
        stream.write(ev.initSegment);
        initSent = true;
      }
      if (ev.data) {
        stream.write(ev.data);
      }
    });

    stream.onAbort(() => {
      active = false;
      transmuxer.dispose();
    });

    try {
      while (active) {
        const res = await fetchWithTimeout(selected.url, {
          headers: { 'User-Agent': ua, 'Referer': referer }
        }, 5000);

        if (!res.ok) {
          await stream.sleep(1500);
          continue;
        }

        const manifest = await res.text();
        const lines = manifest.split('\n');

        const segments: string[] = [];

        for (const l of lines) {
          const t = l.trim();
          if (!t || t.startsWith('#')) continue;

          try {
            segments.push(new URL(t, selected.url).href);
          } catch {}
        }

        // fast-forward live edge
        if (seenSegments.size === 0 && segments.length > 3) {
          segments.slice(0, -2).forEach(s => seenSegments.add(s));
        }

        for (const seg of segments) {
          if (!active || seenSegments.has(seg)) continue;

          try {
            const r = await fetchWithTimeout(seg, {
              headers: { 'User-Agent': ua, 'Referer': referer }
            }, 10000);

            if (r.ok && active) {
              const buf = new Uint8Array(await r.arrayBuffer());
              transmuxer.push(buf);
              transmuxer.flush();
            }
          } catch {}

          seenSegments.add(seg);

          if (seenSegments.size > 60) {
            const first = seenSegments.values().next().value;
            if (first) seenSegments.delete(first);
          }
        }

        await stream.sleep(2000);
      }
    } finally {
      transmuxer.dispose();
    }
  });
}

/* -------------------------------------------------------
   ENTRY ROUTE (UNCHANGED)
------------------------------------------------------- */
router.get('/', async (c) => {
  const id = c.req.query('id');
  const res = c.req.query('res');

  if (!id) throw new HTTPException(400, { message: 'ID required' });

  const original = await getOriginalId(id);
  const key = (original || id).toLowerCase();

  const index = await getStreamIndex();
  let list = index.get(key) || [];

  if (!list.length) {
    throw new HTTPException(404, { message: 'Stream not found' });
  }

  list = list.filter(s => !isQualityTooHigh(s.quality)) || list;

  let selected = list[0];

  if (res) {
    const match = list.find(s => s.quality === res);
    if (match) selected = match;
  }

  return relayStream(c, selected);
});

export default router;