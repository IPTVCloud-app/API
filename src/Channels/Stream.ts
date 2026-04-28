import { Hono } from 'hono';
import axios from 'axios';
// @ts-expect-error - mux.js doesn't have official types
import muxjs from 'mux.js';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

// Persistent caches for stream index
let streamIndex: Map<string, any[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60;  // 1 hour cache

/**
 * Quality Weights
 */
const QUALITY_WEIGHTS: Record<string, number> = { '1080p': 100, '720p': 80, '540p': 60, '480p': 40, 'SD': 20 };
const getQualityWeight = (q: string) => QUALITY_WEIGHTS[q] || 10;
const isQualityTooHigh = (q: string) => getQualityWeight(q) > 100;

export async function getStreamIndex() {
  const now = Date.now();
  if (streamIndex && (now - lastIndexLoad) < INDEX_TTL) return streamIndex;
  const newIndex = new Map<string, any[]>();
  try {
    const response = await axios.get(STREAMS_URL);
    response.data.forEach((s: any) => {
      if (!s.channel) return;
      const key = s.channel.toLowerCase(); // Normalize key
      const list = newIndex.get(key) || [];
      list.push({ url: s.url, quality: s.quality || 'SD', user_agent: s.user_agent || null });
      newIndex.set(key, list);
    });
    for (const [id, streams] of newIndex.entries()) {
      newIndex.set(id, streams.sort((a, b) => getQualityWeight(b.quality) - getQualityWeight(a.quality)));
    }
    streamIndex = newIndex;
    lastIndexLoad = now;
    return streamIndex;
  } catch (err) { return streamIndex || new Map(); }
}

// --- VERCEL-NATIVE REQUEST-SCOPED STREAMING ENGINE ---

// Ephemeral Cache for Fast Starts (Best effort, isolated per Vercel instance)
interface EphemeralCacheEntry {
  initSegment: Buffer | null;
  targetDuration: number;
  mediaPlaylistUrl: string;
  expiresAt: number;
}
const ephemeralCache = new Map<string, EphemeralCacheEntry>();
const EPHEMERAL_TTL = 1000 * 60 * 5; // 5 minutes cache

function getCached(key: string): EphemeralCacheEntry | undefined {
  const entry = ephemeralCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry;
  if (entry) ephemeralCache.delete(key);
  return undefined;
}

function setCached(key: string, data: Partial<EphemeralCacheEntry>) {
  const current = getCached(key) || { initSegment: null, targetDuration: 6, mediaPlaylistUrl: '', expiresAt: 0 };
  ephemeralCache.set(key, { ...current, ...data, expiresAt: Date.now() + EPHEMERAL_TTL });
}

/**
 * Fetch and parse HLS playlist
 */
async function fetchPlaylist(url: string, ua: string) {
  try {
    const { data: content } = await axios.get(url, { headers: { 'User-Agent': ua }, timeout: 4000 });
    
    let mediaUrl = url;
    if (!content.includes('#EXT-X-TARGETDURATION')) {
      const first = content.split('\n').find((l: string) => l.trim() && !l.startsWith('#') && l.toLowerCase().includes('.m3u8'));
      if (first) {
        mediaUrl = first.trim().startsWith('http') ? first.trim() : new URL(first.trim(), url.substring(0, url.lastIndexOf('/') + 1)).href;
      }
      const { data: mediaContent } = await axios.get(mediaUrl, { headers: { 'User-Agent': ua }, timeout: 4000 });
      return { url: mediaUrl, content: mediaContent };
    }
    return { url: mediaUrl, content };
  } catch (err) {
    return null;
  }
}

/**
 * Parse Media Playlist to get segments and target duration
 */
function parseMediaPlaylist(content: string, baseUrl: string) {
  const lines = content.split('\n');
  let targetDuration = 6;
  const segments: { url: string; duration: number }[] = [];
  let curDur = 6;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.split(':')[1], 10) || 6;
    } else if (line.startsWith('#EXTINF:')) {
      curDur = parseFloat(line.split(':')[1]) || 6;
    } else if (line.trim() && !line.startsWith('#')) {
      const url = line.trim().startsWith('http') ? line.trim() : new URL(line.trim(), baseUrl).href;
      segments.push({ url, duration: curDur });
    }
  }
  return { targetDuration, segments };
}

/**
 * High-Performance Native MP4 Proxy (Request-Scoped)
 */
router.get('/', async (c) => {
  const id = c.req.query('id');
  const res = c.req.query('res') || 'auto';
  if (!id) return c.json({ error: 'ID required' }, 400);

  try {
    const origId = await getOriginalId(id);
    const streams = await getStreamIndex();
    
    // Improved Case-Insensitive Lookup
    const searchId = (origId || id).toLowerCase();
    let chStreams = streams.get(searchId) || [];

    if (chStreams.length === 0) return c.json({ error: 'No streams found for this channel' }, 404);
    
    // Permissive Filter: Falls back to all streams if no low-res ones pass
    let allowed = chStreams.filter((s: any) => !isQualityTooHigh(s.quality));
    if (allowed.length === 0) allowed = chStreams; 

    let idx = 0;
    if (res !== 'auto') { 
      const f = allowed.findIndex((s: any) => s.quality === res); 
      if (f !== -1) idx = f; 
    }
    let sel = allowed[idx];
    const ua = sel.user_agent || 'Mozilla/5.0';

    const status = await axios.head(sel.url, { 
      timeout: 1500, 
      headers: { 'User-Agent': ua },
      validateStatus: (s) => s >= 200 && s < 500 
    }).then(r => r.status === 403 ? 'geo-blocked' : (r.status < 400 ? 'online' : 'offline'))
      .catch(() => 'online');

    if (status === 'geo-blocked') return c.json({ code: 403, message: 'Geo-blocked.' }, 403);
    
    const channelKey = `${searchId}_${sel.quality}`.toLowerCase();

    const headers = new Headers();
    headers.set('Content-Type', 'video/mp4');
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Connection', 'keep-alive');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Accel-Buffering', 'no'); // Vercel optimization: Disable proxy buffering

    const signal = c.req.raw.signal;

    const stream = new ReadableStream({
      async start(controller) {
        let transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false, baseMediaDecodeTime: 0 });
        let offset = 0;
        let sentSegments = new Set<string>();
        let cached = getCached(channelKey);
        let mediaPlaylistUrl = cached?.mediaPlaylistUrl || sel.url;
        let targetDuration = cached?.targetDuration || 6;
        let initSegment = cached?.initSegment || null;

        signal.addEventListener('abort', () => {
          try {
            transmuxer.dispose();
            controller.close();
          } catch (e) {}
        });

        transmuxer.on('data', (e: any) => {
          if (signal.aborted) return;
          if (e.initSegment && !initSegment) {
            initSegment = Buffer.from(e.initSegment);
            setCached(channelKey, { initSegment, mediaPlaylistUrl, targetDuration });
            controller.enqueue(initSegment);
          }
          if (e.data) {
            try {
              controller.enqueue(new Uint8Array(e.data));
            } catch (err) {
              // controller likely closed
            }
          }
        });

        if (initSegment) {
          controller.enqueue(initSegment);
        }

        try {
          while (!signal.aborted) {
            const playlist = await fetchPlaylist(mediaPlaylistUrl, ua);
            if (!playlist) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }

            mediaPlaylistUrl = playlist.url;
            const baseUrl = mediaPlaylistUrl.substring(0, mediaPlaylistUrl.lastIndexOf('/') + 1);
            const { targetDuration: td, segments } = parseMediaPlaylist(playlist.content, baseUrl);
            targetDuration = td;
            setCached(channelKey, { targetDuration, mediaPlaylistUrl });

            const fresh = segments.filter(s => !sentSegments.has(s.url));

            if (fresh.length > 0) {
              for (const seg of fresh) {
                if (signal.aborted) break;
                
                try {
                  const res = await axios.get(seg.url, { 
                    responseType: 'arraybuffer', 
                    headers: { 'User-Agent': ua }, 
                    timeout: 8000 
                  });
                  
                  transmuxer.setBaseMediaDecodeTime(offset * 90000);
                  offset += seg.duration;
                  transmuxer.push(new Uint8Array(res.data));
                  transmuxer.flush();
                  
                  sentSegments.add(seg.url);
                  
                  if (sentSegments.size > 50) {
                     const toDelete = Array.from(sentSegments).slice(0, sentSegments.size - 20);
                     toDelete.forEach(k => sentSegments.delete(k));
                  }
                } catch (e) {
                  // Segment download failed, skip
                }
              }
            }

            if (!signal.aborted) {
              const waitTime = fresh.length === 0 ? (targetDuration / 2) * 1000 : targetDuration * 1000;
              await new Promise(r => setTimeout(r, waitTime));
            }
          }
        } catch (error) {
           if (!signal.aborted) {
             try { controller.error(error); } catch (e) {}
           }
        } finally {
          try { transmuxer.dispose(); } catch (e) {}
        }
      }
    });

    return new Response(stream, { headers });
  } catch (error) { return c.json({ error: 'Stream failure' }, 500); }
});

export default router;
