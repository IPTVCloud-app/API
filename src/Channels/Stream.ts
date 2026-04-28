import { Hono } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

/* -------------------------------------------------------
   STREAM INDEX (FAST CACHE)
------------------------------------------------------- */
let streamIndex: Map<string, any[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60;

const QUALITY_WEIGHTS: Record<string, number> = { '1080p': 100, '720p': 80, '540p': 60, '480p': 40, 'SD': 20 };
const getQualityWeight = (q: string) => QUALITY_WEIGHTS[q] || 10;
const isQualityTooHigh = (q: string) => getQualityWeight(q) > 100;

export async function getStreamIndex() {
  const now = Date.now();
  if (streamIndex && now - lastIndexLoad < INDEX_TTL) return streamIndex;

  try {
    const { data } = await axios.get(STREAMS_URL, { timeout: 10000 });
    const map = new Map<string, any[]>();
    data.forEach((s: any) => {
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
  } catch (err) {
    return streamIndex || new Map();
  }
}

/* -------------------------------------------------------
   CONTINUOUS RELAY ENGINE (BLAZINGLY FAST)
------------------------------------------------------- */

/**
 * Highly optimized HLS to TS Relay
 * Designed for Vercel: Stateless, aggressive, and stable.
 */
async function relayStream(c: any, sourceUrl: string, ua: string) {
  return c.stream(async (stream: any) => {
    const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
    const seenSegments = new Set<string>();
    const segmentBuffer: { url: string; promise: Promise<any> }[] = [];
    let isActive = true;

    stream.onAbort(() => { isActive = false; });

    // ⚡ Fast Manifest Monitor
    const monitor = async () => {
      while (isActive) {
        try {
          const { data: manifest } = await axios.get(sourceUrl, {
            headers: { 'User-Agent': ua, 'Referer': new URL(sourceUrl).origin },
            timeout: 4000,
            responseType: 'text'
          });

          const lines = manifest.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              const absUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
              
              if (!seenSegments.has(absUrl)) {
                seenSegments.add(absUrl);
                
                // ⚡ Pre-fetch segment immediately
                const promise = axios.get(absUrl, {
                  headers: { 'User-Agent': ua, 'Referer': new URL(sourceUrl).origin },
                  timeout: 12000,
                  responseType: 'stream'
                }).then(res => res.data).catch(() => null);

                segmentBuffer.push({ url: absUrl, promise });
                if (segmentBuffer.length > 15) segmentBuffer.shift();
              }
            }
          }
          
          // Cleanup
          if (seenSegments.size > 150) {
            const arr = Array.from(seenSegments);
            arr.slice(0, 75).forEach(s => seenSegments.delete(s));
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 2000));
      }
    };

    monitor();

    // ⚡ Sequential Relay Loop
    while (isActive) {
      if (segmentBuffer.length > 0) {
        const { promise } = segmentBuffer.shift()!;
        const segmentStream = await promise;
        
        if (segmentStream) {
          try {
            for await (const chunk of segmentStream) {
              if (!isActive) {
                segmentStream.destroy();
                break;
              }
              await stream.write(chunk);
            }
          } catch (e) {
            if (segmentStream.destroy) segmentStream.destroy();
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 150));
      }
    }
  }, {
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Connection': 'keep-alive',
      'X-Stream-Engine': 'IPTVCloud-V5'
    }
  });
}

/**
 * Entry Point: /api/channels/stream?id=...
 * Replicates the HLS into a stable, single binary stream.
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

  let allowed = list.filter((s: any) => !isQualityTooHigh(s.quality));
  if (!allowed.length) allowed = list;

  let selected = allowed[0];
  if (res !== 'auto') {
    const found = allowed.find((s: any) => s.quality === res);
    if (found) selected = found;
  }

  return relayStream(c, selected.url, selected.user_agent || 'Mozilla/5.0');
});

export default router;