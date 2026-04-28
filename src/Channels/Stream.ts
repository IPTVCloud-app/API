import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import axios from 'axios';
// @ts-ignore
import muxjs from 'mux.js';
import { supabase } from '../Database/DB.js';
import { Readable } from 'stream';

const router = new Hono();

const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

// Persistent caches
let streamIndex: Map<string, any[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60; // 1 hour

// Status Cache
const statusCache = new Map<string, { status: string, time: number }>();
const STATUS_TTL = 1000 * 60 * 5; // 5 minutes

/**
 * Check if a stream is online
 */
async function checkStreamStatus(url: string): Promise<string> {
  if (!url) return 'offline';
  const cached = statusCache.get(url);
  if (cached && (Date.now() - cached.time) < STATUS_TTL) return cached.status;

  try {
    const res = await axios.head(url, { 
      timeout: 1500, 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (status) => status >= 200 && status < 500
    });
    
    let status = 'offline';
    if (res.status === 403) {
      status = 'geo-blocked';
    } else if (res.status < 400) {
      status = 'online';
    }
    
    statusCache.set(url, { status, time: Date.now() });
    return status;
  } catch (err: any) {
    if (err.response?.status === 403) {
      statusCache.set(url, { status: 'geo-blocked', time: Date.now() });
      return 'geo-blocked';
    }
    statusCache.set(url, { status: 'offline', time: Date.now() });
    return 'offline';
  }
}

/**
 * Quality Weighting
 */
const QUALITY_WEIGHTS: Record<string, number> = {
  '1080p': 100,
  '720p': 80,
  '540p': 60,
  '480p': 40,
  'SD': 20
};

function getQualityWeight(q: string): number {
  if (!q) return 0;
  const lower = q.toLowerCase();
  if (lower.includes('4k') || lower.includes('2160p')) return 1000;
  return QUALITY_WEIGHTS[q] || 10;
}

function isQualityTooHigh(quality: string): boolean {
  return getQualityWeight(quality) > 100;
}

/**
 * Lightweight Multi-Stream Indexer
 */
export async function getStreamIndex() {
  const now = Date.now();
  if (streamIndex && (now - lastIndexLoad) < INDEX_TTL) return streamIndex;

  const newIndex = new Map<string, any[]>();
  try {
    const response = await axios.get(STREAMS_URL);
    response.data.forEach((s: any) => {
      if (!s.channel) return;
      const list = newIndex.get(s.channel) || [];
      list.push({ url: s.url, quality: s.quality || 'SD', user_agent: s.user_agent || null, label: s.label || null });
      newIndex.set(s.channel, list);
    });
    for (const [id, streams] of newIndex.entries()) {
      newIndex.set(id, streams.sort((a, b) => getQualityWeight(b.quality) - getQualityWeight(a.quality)));
    }
    streamIndex = newIndex;
    lastIndexLoad = now;
    return streamIndex;
  } catch (err) { return streamIndex || new Map(); }
}

/**
 * High-Performance Native MP4 Proxy (No FFmpeg)
 * Transmuxes TS segments into fMP4 fragments on-the-fly.
 */
router.get('/stream', async (c) => {
  const shortId = c.req.query('id');
  const resolution = c.req.query('res');
  const isHls = c.req.query('hls') === 'true';
  
  if (!shortId) return c.json({ error: 'Channel ID required' }, 400);

  try {
    const originalId = await getOriginalId(shortId);
    const streams = await getStreamIndex();
    const chStreams = streams.get(originalId || shortId) || [];
    const allowedStreams = chStreams.filter((s: any) => !isQualityTooHigh(s.quality));

    if (allowedStreams.length === 0) return c.json({ error: 'No supported streams found' }, 404);
    const selected = (resolution ? allowedStreams.find((s: any) => s.quality === resolution) : null) || allowedStreams[0];

    // 1. Initial Status Check
    const status = await checkStreamStatus(selected.url);
    if (status === 'geo-blocked') {
      return c.json({ 
        code: 403, 
        message: 'This stream is geo-blocked in your region/IP. Please use a VPN or try another channel.' 
      }, 403);
    }
    if (status === 'offline') return c.json({ error: 'Stream is offline' }, 404);

    // 2. Setup Transmuxer & Native Stream
    const stream = new Readable({ read() {} });
    const transmuxer = new muxjs.mp4.Transmuxer({
        keepOriginalTimestamps: true,
        baseMediaDecodeTime: 0
    });

    let initSegmentSent = false;
    transmuxer.on('data', (event: any) => {
        if (!initSegmentSent && event.initSegment) {
            stream.push(Buffer.from(event.initSegment));
            initSegmentSent = true;
        }
        if (event.data) {
            stream.push(Buffer.from(event.data));
        }
    });

    const userAgent = selected.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const sentSegments = new Set<string>();
    let isClosed = false;

    // Fast Loading: Pre-fetch queue
    const segmentQueue: { url: string, data: Buffer | null }[] = [];
    const MAX_QUEUE = 3;

    const fillQueue = async (m3u8Url: string) => {
      if (isClosed) return;
      try {
        const { data: playlist } = await axios.get(m3u8Url, { 
          headers: { 'User-Agent': userAgent },
          timeout: 3000
        });

        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
        const segments = playlist.split('\n')
          .filter((line: string) => line.trim() && !line.startsWith('#'))
          .map((line: string) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('http')) return trimmed;
            return new URL(trimmed, baseUrl).href;
          });

        for (const segUrl of segments) {
          if (sentSegments.has(segUrl) || isClosed) continue;
          if (segmentQueue.length >= MAX_QUEUE) break;
          
          if (!segmentQueue.find(s => s.url === segUrl)) {
            const queueItem: { url: string, data: Buffer | null } = { url: segUrl, data: null };
            segmentQueue.push(queueItem);
            
            axios.get(segUrl, { 
              responseType: 'arraybuffer', 
              headers: { 'User-Agent': userAgent },
              timeout: 5000 
            }).then(res => {
              if (isClosed) return;
              queueItem.data = Buffer.from(res.data);
            }).catch(() => {
              const idx = segmentQueue.findIndex(s => s.url === segUrl);
              if (idx !== -1) segmentQueue.splice(idx, 1);
            });
          }
        }
      } catch (e) {}
    };

    const processStream = async () => {
      while (!isClosed) {
        await fillQueue(selected.url);

        if (segmentQueue.length > 0 && segmentQueue[0].data) {
			const item = segmentQueue.shift()!;
			if (isHls) {
				stream.push(item.data!);
			} else {
				transmuxer.push(new Uint8Array(item.data!));
				transmuxer.flush();
			}
			sentSegments.add(item.url);
          
          if (sentSegments.size > 50) {
            const first = sentSegments.values().next().value;
            if (first) sentSegments.delete(first);
          }
        } else if (segmentQueue.length > 0 && !segmentQueue[0].data) {
           await new Promise(r => setTimeout(r, 200));
        } else {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    };

    processStream();

    c.req.raw.signal?.addEventListener('abort', () => {
      isClosed = true;
      stream.push(null);
    });

    return c.body(stream as any, 200, {
      'Content-Type': isHls ? 'video/mp2t' : 'video/mp4',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });

  } catch (error) { 
    console.error('Stream controller error:', error);
    return c.json({ error: 'Stream controller error' }, 500); 
  }
});

export async function getShortId(originalId: string): Promise<string> {
  try {
    const { data: existing } = await supabase.from('channel_mappings').select('short_id').eq('original_id', originalId).single();
    if (existing) return existing.short_id;
    const shortId = nanoid(12);
    await supabase.from('channel_mappings').insert([{ original_id: originalId, short_id: shortId }]);
    return shortId;
  } catch (err) { return originalId; }
}

export async function getOriginalId(shortId: string): Promise<string | null> {
  try {
    const { data: existing } = await supabase.from('channel_mappings').select('original_id').eq('short_id', shortId).single();
    return existing?.original_id || shortId;
  } catch (err) { return shortId; }
}

export default router;