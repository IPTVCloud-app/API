import { Hono } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
// @ts-ignore
import muxjs from 'mux.js';
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
   CONTINUOUS RELAY ENGINE (fMP4 TRANSMUXING)
------------------------------------------------------- */

/**
 * Highly optimized HLS to fMP4 Relay
 * Designed for Vercel: Stateless, aggressive, and stable.
 */
async function relayStream(c: any, sourceUrl: string, ua: string) {
  return stream(c, async (streamInstance: any) => {
    const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
    const seenSegments = new Set<string>();
    const segmentBuffer: { url: string; promise: Promise<any> }[] = [];
    let isActive = true;

    // ⚡ fMP4 Transmuxer Setup
    const transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: true,
    });

    // Handle transmuxed data
    transmuxer.on('data', (event: any) => {
      // event.initSegment: ftyp and moov
      // event.data: mdat and moof
      if (event.initSegment) {
        streamInstance.write(event.initSegment).catch(() => { isActive = false; });
      }
      if (event.data) {
        streamInstance.write(event.data).catch(() => { isActive = false; });
      }
    });

    streamInstance.onAbort(() => {
      isActive = false;
      transmuxer.dispose();
    });

    // ⚡ Fast Manifest Monitor
    const monitor = async () => {
      while (isActive) {
        try {
          const { data: manifest } = await axios.get(sourceUrl, {
            headers: { 'User-Agent': ua, 'Referer': new URL(sourceUrl).origin },
            timeout: 5000,
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
                  timeout: 20000,
                  responseType: 'stream'
                }).then(res => res.data).catch(() => null);

                segmentBuffer.push({ url: absUrl, promise });
                if (segmentBuffer.length > 25) segmentBuffer.shift();
              }
            }
          }
          
          if (seenSegments.size > 200) {
            const arr = Array.from(seenSegments);
            arr.slice(0, 100).forEach(s => seenSegments.delete(s));
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 2000));
      }
    };

    monitor();

    // ⚡ Initial Delay to build buffer for "Blazingly Fast" start
    await new Promise(r => setTimeout(r, 1500));

    // ⚡ Sequential Relay Loop
    while (isActive) {
      if (segmentBuffer.length > 0) {
        const item = segmentBuffer.shift();
        if (!item) continue;
        const segmentStream = await item.promise;
        
        if (segmentStream && isActive) {
          try {
            for await (const chunk of segmentStream) {
              if (!isActive) break;
              // Push TS chunk into transmuxer
              transmuxer.push(new Uint8Array(chunk));
              transmuxer.flush();
            }
            if (segmentStream.destroy) segmentStream.destroy();
          } catch (e: any) {
            if (segmentStream.destroy) segmentStream.destroy();
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    transmuxer.dispose();
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

  // Set Relay Headers optimized for fMP4 video support and speed
  c.header('Content-Type', 'video/mp4');
  c.header('Content-Disposition', 'inline');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Connection', 'keep-alive');
  c.header('X-Stream-Engine', 'IPTVCloud-fMP4-V8');

  return relayStream(c, selected.url, selected.user_agent || 'Mozilla/5.0');
});

export default router;
