import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import axios from 'axios';
// @ts-expect-error - mux.js doesn't have official types
import muxjs from 'mux.js';
import { supabase } from '../Database/DB.js';
import { Readable } from 'stream';

const router = new Hono();

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

// Metadata Sources
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const LANGUAGES_URL = 'https://iptv-org.github.io/api/languages.json';
const REGIONS_URL = 'https://iptv-org.github.io/api/regions.json';
const TIMEZONES_URL = 'https://iptv-org.github.io/api/timezones.json';

// Persistent caches
let streamIndex: Map<string, any[]> | null = null;
let metadataMaps: {
  countries: Map<string, any>;
  languages: Map<string, string>;
  regions: Map<string, string>;
  timezones: Map<string, string[]>;
} | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60; // 1 hour

// Status Cache
const statusCache = new Map<string, { status: string, time: number }>();
const STATUS_TTL = 1000 * 60 * 5; // 5 minutes

/**
 * Build Metadata Lookups
 */
async function getMetadataMaps() {
  const now = Date.now();
  if (metadataMaps && (now - lastIndexLoad) < INDEX_TTL) return metadataMaps;

  try {
    const [cnt, lng, reg, tz] = await Promise.all([
      axios.get(COUNTRIES_URL).then(r => r.data),
      axios.get(LANGUAGES_URL).then(r => r.data),
      axios.get(REGIONS_URL).then(r => r.data),
      axios.get(TIMEZONES_URL).then(r => r.data)
    ]);

    const countryToTz = new Map<string, string[]>();
    tz.forEach((t: { code?: string; countries?: string[] }) => {
      t.countries?.forEach((code: string) => {
        const list = countryToTz.get(code) || [];
        if (t.code) list.push(t.code);
        countryToTz.set(code, list);
      });
    });

    metadataMaps = {
      countries: new Map(cnt.map((c: { code: string }) => [c.code, c])),
      languages: new Map(lng.map((l: { code: string; name: string }) => [l.code, l.name])),
      regions: new Map(reg.map((r: { code: string; name: string }) => [r.code, r.name])),
      timezones: countryToTz
    };
    return metadataMaps;
  } catch (err) {
    console.error('[Metadata] Failed to load metadata:', err);
    return metadataMaps || { countries: new Map(), languages: new Map(), regions: new Map(), timezones: new Map() };
  }
}

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
async function getStreamIndex() {
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

interface FilterOptions {
  country?: string;
  category?: string;
  language?: string;
  region?: string;
  nsfw?: boolean;
  network?: string;
  geo_blocked?: boolean;
  is_active?: boolean;
  subdivision?: string;
  owner?: string;
}

/**
 * Manual Streaming JSON Parser
 */
async function fetchChannelsSegmented(offset: number, limit: number, baseUrl: string, search?: string, filters: FilterOptions = {}) {
  const streams = await getStreamIndex();
  const meta = await getMetadataMaps();
  const searchLower = search?.toLowerCase();
  
  const response = await axios({ method: 'get', url: CHANNELS_URL, responseType: 'stream' });
  const streamData = response.data as Readable;
  const results: any[] = [];
  let currentObject = '';
  let bracketDepth = 0;
  let matchesFound = 0;
  let inString = false;
  let isEscaped = false;

  return new Promise<any[]>((resolve, reject) => {
    streamData.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (inString) {
          currentObject += char;
          if (isEscaped) isEscaped = false;
          else if (char === '\\') isEscaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') { inString = true; currentObject += char; continue; }
        if (char === '{') {
          if (bracketDepth === 0) currentObject = '';
          bracketDepth++;
          currentObject += char;
        } else if (char === '}') {
          bracketDepth--;
          currentObject += char;
          if (bracketDepth === 0) {
            try {
              const ch = JSON.parse(currentObject);
              const countryInfo = meta.countries.get(ch.country);
              const chStreams = streams.get(ch.id) || [];
              const isGeoBlocked = chStreams.some((s: any) => s.label?.toLowerCase().includes('geo-blocked'));

              const matchesSearch = !searchLower || 
                ch.name?.toLowerCase().includes(searchLower) || 
                ch.id?.toLowerCase().includes(searchLower) ||
                ch.country?.toLowerCase().includes(searchLower) ||
                ch.categories?.some((cat: string) => cat.toLowerCase().includes(searchLower));

              if (!matchesSearch) continue;

              if (filters.country && ch.country !== filters.country) continue;
              if (filters.category && !ch.categories?.includes(filters.category)) continue;
              if (filters.language && !ch.languages?.includes(filters.language)) continue;
              if (filters.region && countryInfo?.region !== filters.region) continue;
              if (filters.nsfw !== undefined && ch.is_nsfw !== filters.nsfw) continue;
              if (filters.network && ch.network?.toLowerCase() !== filters.network.toLowerCase()) continue;
              if (filters.geo_blocked !== undefined && isGeoBlocked !== filters.geo_blocked) continue;
              if (filters.is_active !== undefined && (!!ch.closed !== !filters.is_active)) continue;
              if (filters.subdivision && ch.subdivision !== filters.subdivision) continue;
              if (filters.owner && !ch.owners?.some((o: string) => o.toLowerCase() === filters.owner?.toLowerCase())) continue;

              if (matchesFound < offset) {
                matchesFound++;
              } else {
                const allowedStreams = chStreams.filter((s: any) => !isQualityTooHigh(s.quality));
                const langNames = ch.languages?.map((l: any) => meta.languages.get(l)).filter(Boolean) || [];
                const tzList = meta.timezones.get(ch.country) || [];

                results.push({
                  ...ch,
                  country_name: countryInfo?.name || null,
                  region: countryInfo?.region || null,
                  city: ch.city || null,
                  subdivision: ch.subdivision || null,
                  timezones: tzList.length > 0 ? tzList : null,
                  languages_names: langNames.length > 0 ? langNames : null,
                  geo_blocked: isGeoBlocked,
                  highest_allowed_quality: allowedStreams.length > 0 ? allowedStreams[0].quality : null,
                  available_streams: allowedStreams.length,
                  available_resolutions: allowedStreams.map((s: any) => s.quality),
                  primary_stream_url: allowedStreams.length > 0 ? allowedStreams[0].url : null
                });
                if (results.length >= limit) { streamData.destroy(); resolve(results); return; }
              }
            } catch (e) {}
          }
        } else if (bracketDepth > 0) {
          currentObject += char;
        }
      }
    });
    streamData.on('end', () => resolve(results));
    streamData.on('error', (err) => reject(err));
  });
}

/**
 * High-Performance Native MP4 Proxy (No FFmpeg)
 * Transmuxes TS segments into fMP4 fragments on-the-fly.
 */
router.get('/stream', async (c) => {
  const shortId = c.req.query('id');
  const resolution = c.req.query('res');
  
  if (!shortId) return c.json({ error: 'ID required' }, 400);

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
    interface QueueItem { url: string, data: Buffer | null }
    const segmentQueue: QueueItem[] = [];
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
            const queueItem: QueueItem = { url: segUrl, data: null };
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
          if (item.data) {
            transmuxer.push(new Uint8Array(item.data));
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
      'Content-Type': 'video/mp4',
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

router.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 50);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const search = c.req.query('search');
  const statusFilter = c.req.query('status');
  
  const filters: FilterOptions = {
    country: c.req.query('country'),
    category: c.req.query('category'),
    language: c.req.query('language'),
    region: c.req.query('region'),
    nsfw: c.req.query('nsfw') === 'true' ? true : (c.req.query('nsfw') === 'false' ? false : undefined),
    network: c.req.query('network'),
    geo_blocked: c.req.query('geo_blocked') === 'true' ? true : (c.req.query('geo_blocked') === 'false' ? false : undefined),
    is_active: c.req.query('is_active') === 'true' ? true : (c.req.query('is_active') === 'false' ? false : undefined),
    subdivision: c.req.query('subdivision'),
    owner: c.req.query('owner')
  };

  const protocol = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host');
  const baseUrl = `${protocol}://${host}`;
  
  try {
    const scanLimit = statusFilter ? limit * 2 : limit;
    const enrichedSlice = await fetchChannelsSegmented(offset, scanLimit, baseUrl, search, filters);
    const resultsWithStatus = await Promise.all(enrichedSlice.map(async (ch: any) => {
      const shortId = await getShortId(ch.id);
      const status = await checkStreamStatus(ch.primary_stream_url);
      const item = { ...ch, id: shortId, original_id: ch.id, stream: `${baseUrl}/api/channels/stream?id=${shortId}`, status: status };
      delete (item as any).primary_stream_url;
      return item;
    }));
    let finalResults = resultsWithStatus;
    if (statusFilter === 'online' || statusFilter === 'offline') {
      finalResults = resultsWithStatus.filter(res => res.status === statusFilter);
    }
    return c.json(finalResults.slice(0, limit));
  } catch (error: any) { return c.json({ code: 500, message: 'Streaming error', detail: error.message }, 500); }
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.redirect(`/api/channels/stream?id=${id}`);
});

export default router;
