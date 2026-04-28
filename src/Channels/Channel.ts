import { Hono } from 'hono';
import { stream } from 'hono/streaming';
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
const CATEGORIES_URL = 'https://iptv-org.github.io/api/categories.json';
const CITIES_URL = 'https://iptv-org.github.io/api/cities.json';
const SUBDIVISIONS_URL = 'https://iptv-org.github.io/api/subdivisions.json';

// Persistent caches
let streamIndex: Map<string, any[]> | null = null;
let metadataMaps: {
  countries: Map<string, any>;
  languages: Map<string, string>;
  regions: Map<string, string>;
  timezones: Map<string, string[]>;
  categories: any[];
  cities: any[];
  subdivisions: any[];
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
    const [cnt, lng, reg, tz, cat, city, sub] = await Promise.all([
      axios.get(COUNTRIES_URL).then(r => r.data),
      axios.get(LANGUAGES_URL).then(r => r.data),
      axios.get(REGIONS_URL).then(r => r.data),
      axios.get(TIMEZONES_URL).then(r => r.data),
      axios.get(CATEGORIES_URL).then(r => r.data),
      axios.get(CITIES_URL).then(r => r.data),
      axios.get(SUBDIVISIONS_URL).then(r => r.data)
    ]);
    const countryToTz = new Map<string, string[]>();
    tz.forEach((t: any) => {
      t.countries?.forEach((code: string) => {
        const list = countryToTz.get(code) || [];
        if (t.code) list.push(t.code);
        countryToTz.set(code, list);
      });
    });
    metadataMaps = {
      countries: new Map(cnt.map((c: any) => [c.code, c])),
      languages: new Map(lng.map((l: any) => [l.code, l.name])),
      regions: new Map(reg.map((r: any) => [r.code, r.name])),
      timezones: countryToTz,
      categories: cat,
      cities: city,
      subdivisions: sub
    };
    return metadataMaps;
  } catch (err) {
    console.error('[Metadata] Failed to load metadata:', err);
    return metadataMaps || { countries: new Map(), languages: new Map(), regions: new Map(), timezones: new Map(), categories: [], cities: [], subdivisions: [] };
  }
}

/**
 * Metadata Endpoints
 */
router.get('/categories', async (c) => {
  const meta = await getMetadataMaps();
  return c.json(meta.categories);
});

router.get('/languages', async (c) => {
  const meta = await getMetadataMaps();
  const list = Array.from(meta.languages.entries()).map(([code, name]) => ({ code, name }));
  return c.json(list);
});

router.get('/cities', async (c) => {
  const meta = await getMetadataMaps();
  return c.json(meta.cities);
});

router.get('/subdivisions', async (c) => {
  const meta = await getMetadataMaps();
  return c.json(meta.subdivisions);
});

router.get('/countries', async (c) => {
  const meta = await getMetadataMaps();
  const list = Array.from(meta.countries.values());
  return c.json(list);
});

router.get('/regions', async (c) => {
  const meta = await getMetadataMaps();
  const list = Array.from(meta.regions.entries()).map(([code, name]) => ({ code, name }));
  return c.json(list);
});

/**
 * Check if a stream is online
 */
async function checkStreamStatus(url: string | null): Promise<string> {
  if (!url) return 'offline';
  const cached = statusCache.get(url);
  if (cached && (Date.now() - cached.time) < STATUS_TTL) return cached.status;
  try {
    const res = await axios.head(url, { 
      timeout: 2000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (status) => status >= 200 && status < 500
    });
    let status = 'offline';
    if (res.status === 403) status = 'geo-blocked';
    else if (res.status < 400) status = 'online';
    else {
      try {
        await axios.get(url, { 
          timeout: 2000, headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
          validateStatus: (status) => status >= 200 && status < 400
        });
        status = 'online';
      } catch (e) {}
    }
    statusCache.set(url, { status, time: Date.now() });
    return status;
  } catch (err: any) {
    if (err.response?.status === 403) {
      statusCache.set(url, { status: 'geo-blocked', time: Date.now() });
      return 'geo-blocked';
    }
    try {
      await axios.get(url, { 
        timeout: 2000, headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
        validateStatus: (status) => status >= 200 && status < 400
      });
      statusCache.set(url, { status: 'online', time: Date.now() });
      return 'online';
    } catch (e: any) {
      const finalStatus = e.response?.status === 403 ? 'geo-blocked' : 'offline';
      statusCache.set(url, { status: finalStatus, time: Date.now() });
      return finalStatus;
    }
  }
}

/**
 * Quality Weights
 */
const QUALITY_WEIGHTS: Record<string, number> = { '1080p': 100, '720p': 80, '540p': 60, '480p': 40, 'SD': 20 };
const getQualityWeight = (q: string) => QUALITY_WEIGHTS[q] || 10;
const isQualityTooHigh = (q: string) => getQualityWeight(q) > 100;

async function getStreamIndex() {
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

// --- SHARED STREAMING ENGINE (DVR ENABLED) ---

interface CachedSegment { url: string; data: Buffer; duration: number; }
interface SharedStream {
  mediaPlaylistUrl: string; userAgent: string;
  segments: CachedSegment[]; initSegment: Buffer | null;
  totalTimeOffset: number; lastUpdate: number;
  viewers: number; isUpdating: boolean; timer?: NodeJS.Timeout;
}
const globalStreamRegistry = new Map<string, SharedStream>();
const MAX_SEGMENTS_CACHE = 100; // Sliding window for DVR (approx 10-15 mins)

async function runPuller(channelKey: string) {
  const shared = globalStreamRegistry.get(channelKey);
  if (!shared || shared.viewers <= 0) {
    if (shared?.timer) clearInterval(shared.timer);
    globalStreamRegistry.delete(channelKey);
    return;
  }
  if (shared.isUpdating) return;
  shared.isUpdating = true;
  try {
    const { data: playlist } = await axios.get(shared.mediaPlaylistUrl, { headers: { 'User-Agent': shared.userAgent }, timeout: 3000 });
    const lines = playlist.split('\n');
    const baseUrl = shared.mediaPlaylistUrl.substring(0, shared.mediaPlaylistUrl.lastIndexOf('/') + 1);
    let curDur = 10;
    const pending: { url: string, duration: number }[] = [];
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) curDur = parseFloat(line.split(':')[1]) || 10;
      else if (line.trim() && !line.startsWith('#') && !line.toLowerCase().includes('.m3u8')) {
        const url = line.trim().startsWith('http') ? line.trim() : new URL(line.trim(), baseUrl).href;
        if (!shared.segments.find(s => s.url === url)) pending.push({ url, duration: curDur });
      }
    }
    const newSegs = await Promise.all(pending.map(async (seg) => {
      try {
        const res = await axios.get(seg.url, { responseType: 'arraybuffer', headers: { 'User-Agent': shared.userAgent }, timeout: 5000 });
        return { url: seg.url, data: Buffer.from(res.data), duration: seg.duration };
      } catch (e) { return null; }
    }));

    if (!shared.initSegment && newSegs.length > 0 && newSegs[0]) {
       const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
       transmuxer.on('data', (event: any) => { if (event.initSegment) shared.initSegment = Buffer.from(event.initSegment); });
       transmuxer.push(new Uint8Array(newSegs[0].data));
       transmuxer.flush();
    }
    for (const s of newSegs) {
      if (s) {
        shared.segments.push(s);
        shared.totalTimeOffset += s.duration;
        if (shared.segments.length > MAX_SEGMENTS_CACHE) shared.segments.shift();
      }
    }
    shared.lastUpdate = Date.now();
  } catch (e) {} finally { shared.isUpdating = false; }
}

async function getShared(channelKey: string, initialUrl: string, ua: string): Promise<SharedStream> {
  let shared = globalStreamRegistry.get(channelKey);
  if (!shared) {
    let mediaUrl = initialUrl;
    try {
       const { data: content } = await axios.get(initialUrl, { headers: { 'User-Agent': ua }, timeout: 2500 });
       if (!content.includes('#EXT-X-TARGETDURATION')) {
         const first = content.split('\n').find((l: string) => l.trim() && !l.startsWith('#') && l.toLowerCase().includes('.m3u8'));
         if (first) mediaUrl = first.trim().startsWith('http') ? first.trim() : new URL(first.trim(), initialUrl.substring(0, initialUrl.lastIndexOf('/') + 1)).href;
       }
    } catch (e) {}
    shared = { mediaPlaylistUrl: mediaUrl, userAgent: ua, segments: [], initSegment: null, totalTimeOffset: 0, lastUpdate: 0, viewers: 0, isUpdating: false };
    globalStreamRegistry.set(channelKey, shared);
    await runPuller(channelKey);
    shared.timer = setInterval(() => runPuller(channelKey), 4000);
  }
  return shared;
}

/**
 * High-Performance Native MP4 Proxy
 */
router.get('/stream', async (c) => {
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
    
    // Permissive Filter: Fallback to all streams if no low-res ones pass
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
    
    const channelKey = `${searchId}_${sel.quality}`; // Normalized key
    const shared = await getShared(channelKey, sel.url, ua);

    // CRITICAL: Wait for initSegment
    let waitCount = 0;
    while (!shared.initSegment && waitCount < 20) {
      await new Promise(r => setTimeout(r, 500));
      waitCount++;
    }

    if (!shared.initSegment) return c.json({ error: 'Failed to initialize stream' }, 503);

    c.header('Content-Type', 'video/mp4');
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.header('Connection', 'keep-alive');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Access-Control-Allow-Origin', '*');

    return stream(c, async (stream) => {
      await stream.write(shared.initSegment!);

      const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false, baseMediaDecodeTime: 0 });
      let closed = false;
      c.req.raw.signal?.addEventListener('abort', () => { closed = true; });

      transmuxer.on('data', async (e: any) => { 
        if (e.data && !closed) {
          try {
            await stream.write(Buffer.from(e.data));
          } catch (err) { closed = true; }
        } 
      });

      const sent = new Set<string>();
      let offset = 0;

      const warm = shared.segments.slice(-5);
      for (const s of warm) {
        if (closed) break;
        transmuxer.setBaseMediaDecodeTime(offset * 90000);
        offset += s.duration;
        transmuxer.push(new Uint8Array(s.data));
        transmuxer.flush();
        sent.add(s.url);
      }

      try {
        shared.viewers++;
        while (!closed) {
          const fresh = shared.segments.filter(s => !sent.has(s.url));
          if (fresh.length > 0) {
            for (const s of fresh) {
              if (closed) break;
              transmuxer.setBaseMediaDecodeTime(offset * 90000);
              offset += s.duration;
              transmuxer.push(new Uint8Array(s.data));
              transmuxer.flush();
              sent.add(s.url);
            }
          } else {
            if (!closed) await stream.write(Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]));
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      } finally {
        shared.viewers--;
        closed = true;
      }
    });
  } catch (error) { return c.json({ error: 'Stream error' }, 500); }
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
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  
  // Robust Case-Insensitive Parameters
  const query = c.req.query();
  const getParam = (key: string) => {
    const k = key.toLowerCase();
    for (const [qKey, val] of Object.entries(query)) {
      if (qKey.toLowerCase() === k) return val;
    }
    return null;
  };

  const search = getParam('search');
  const category = getParam('category');
  const language = getParam('language');
  const country = getParam('country');
  const city = getParam('city');
  const subdivision = getParam('subdivision');
  const region = getParam('region');

  const protocol = c.req.header('x-forwarded-proto') || 'http';
  const baseUrl = `${protocol}://${c.req.header('host')}`;

  try {
    const filters = { 
      category: category?.toString(), 
      language: language?.toString(), 
      country: country?.toString(), 
      city: city?.toString(), 
      subdivision: subdivision?.toString(), 
      region: region?.toString() 
    };
    
    const channels = await fetchChannelsSegmented(offset, limit, baseUrl, search?.toString(), filters);
    const streams = await getStreamIndex();
    
    const results = await Promise.all(channels.map(async (ch: any) => {
      const shortId = await getShortId(ch.id);
      
      // Use normalized index
      const chStreams = streams.get(ch.id.toLowerCase()) || [];
      const allowed = chStreams.filter((s: any) => !isQualityTooHigh(s.quality));
      const primaryUrl = allowed.length > 0 ? allowed[0].url : (chStreams.length > 0 ? chStreams[0].url : null);
      
      const status = await checkStreamStatus(primaryUrl);

      return { 
        ...ch, id: shortId, original_id: ch.id, 
        stream: `${baseUrl}/api/channels/stream?id=${shortId}`, 
        thumbnail: `${baseUrl}/api/channels/thumbnail?id=${shortId}`,
        logo: `${baseUrl}/api/channels/logo?id=${shortId}`,
        status, 
        available_resolutions: allowed.map((s: any) => s.quality), 
        abr_supported: allowed.length > 1
      };
    }));
    return c.json(results);
  } catch (error: any) { 
    return c.json({ error: 'List error' }, 500); 
  }
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.redirect(`/api/channels/stream?id=${id}`);
});

/**
 * Manual Streaming JSON Parser (Optimized for Vercel RAM)
 */
async function fetchChannelsSegmented(offset: number, limit: number, baseUrl: string, search?: string, filters: any = {}) {
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
        if (char === '{') { if (bracketDepth === 0) currentObject = ''; bracketDepth++; currentObject += char; } 
        else if (char === '}') {
          bracketDepth--; currentObject += char;
          if (bracketDepth === 0) {
            try {
              const ch = JSON.parse(currentObject);
              
              if (filters.category && !ch.categories?.includes(filters.category)) continue;
              if (filters.language && !ch.languages?.includes(filters.language)) continue;
              if (filters.country && ch.country !== filters.country) continue;
              if (filters.city && ch.city !== filters.city) continue;
              if (filters.subdivision && ch.subdivision !== filters.subdivision) continue;
              if (filters.region && meta.countries.get(ch.country)?.region !== filters.region) continue;

              // Use normalized lookup in segmented fetch too
              const chStreams = streams.get(ch.id.toLowerCase()) || [];
              const matchesSearch = !searchLower || 
                ch.name?.toLowerCase().includes(searchLower) || 
                ch.id?.toLowerCase().includes(searchLower) ||
                ch.categories?.some((cat: string) => cat.toLowerCase().includes(searchLower)) ||
                ch.country?.toLowerCase().includes(searchLower) ||
                ch.city?.toLowerCase().includes(searchLower);

              if (!matchesSearch) continue;
              if (matchesFound < offset) { matchesFound++; } 
              else {
                const isGeoBlocked = chStreams.some((s: any) => s.label?.toLowerCase().includes('geo-blocked'));
                const allowed = chStreams.filter((s: any) => !isQualityTooHigh(s.quality));
                const langNames = ch.languages?.map((l: any) => meta.languages.get(l)).filter(Boolean) || [];

                results.push({
                  ...ch, country_name: meta.countries.get(ch.country)?.name || null, 
                  region: meta.countries.get(ch.country)?.region || null,
                  languages_names: langNames, geo_blocked: isGeoBlocked,
                  highest_allowed_quality: allowed.length > 0 ? allowed[0].quality : null
                });
                if (results.length >= limit) { streamData.destroy(); resolve(results); return; }
              }
            } catch (e) {}
          }
        } else if (bracketDepth > 0) currentObject += char;
      }
    });
    streamData.on('end', () => resolve(results));
    streamData.on('error', (err) => reject(err));
  });
}

export default router;