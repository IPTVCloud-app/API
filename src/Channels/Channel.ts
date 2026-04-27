import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import axios from 'axios';
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
let metadataMaps: any = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60; // 1 hour

// Status cache (URL -> { status: string, time: number })
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

    // Map country code to list of timezone names (using 'code' field)
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
      validateStatus: (status) => status >= 200 && status < 400
    });
    const status = res.status < 400 ? 'online' : 'offline';
    statusCache.set(url, { status, time: Date.now() });
    return status;
  } catch (err) {
    try {
      await axios.get(url, { 
        timeout: 1500, 
        headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
        validateStatus: (status) => status >= 200 && status < 400
      });
      statusCache.set(url, { status: 'online', time: Date.now() });
      return 'online';
    } catch (e) {
      statusCache.set(url, { status: 'offline', time: Date.now() });
      return 'offline';
    }
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
                
                // Construct clean object: Use data or null for empty
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
 * ABR Stream Controller
 */
router.get('/stream', async (c) => {
  const shortId = c.req.query('id');
  const resolution = c.req.query('res');
  const protocol = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host');
  const baseUrl = `${protocol}://${host}`;
  
  if (!shortId) return c.json({ error: 'ID required' }, 400);

  try {
    const originalId = await getOriginalId(shortId);
    const streams = await getStreamIndex();
    const chStreams = streams.get(originalId || shortId) || [];
    const allowedStreams = chStreams.filter((s: any) => !isQualityTooHigh(s.quality));

    if (allowedStreams.length === 0) return c.json({ error: 'No supported streams found' }, 404);

    const highestAvailable = allowedStreams[0];

    // 1. Browser Detection
    const acceptHeader = c.req.header('accept') || '';
    if (!resolution && acceptHeader.includes('text/html')) {
      const playerUrl = `${baseUrl}/api/channels/stream?id=${shortId}`;
      return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>IPTVCloud Player</title>
          <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
          <style>
            body { margin: 0; background: #000; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
            video { width: 100%; height: 100%; max-width: 100vw; max-height: 100vh; }
            .info { position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.5); padding: 5px 10px; border-radius: 5px; pointer-events: none; }
          </style>
        </head>
        <body>
          <div class="info">Playing: ${shortId} (${highestAvailable.quality})</div>
          <video id="video" controls autoplay playsinline></video>
          <script>
            var video = document.getElementById('video');
            var streamUrl = '${playerUrl}';
            if (Hls.isSupported()) {
              var hls = new Hls();
              hls.loadSource(streamUrl);
              hls.attachMedia(video);
              hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play(); });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
              video.src = streamUrl;
              video.addEventListener('loadedmetadata', function() { video.play(); });
            }
          </script>
        </body>
        </html>
      `);
    }

    // 2. Specific Resolution Proxy
    if (resolution) {
      if (getQualityWeight(resolution) > getQualityWeight(highestAvailable.quality)) {
        return c.json({ code: 403, message: `Quality limit exceeded.` }, 403);
      }
      const selected = allowedStreams.find((s: any) => s.quality === resolution) || highestAvailable;
      const response = await axios.get(selected.url, { responseType: 'text', headers: { 'User-Agent': selected.user_agent || 'Mozilla/5.0' } });
      let content = response.data;
      const streamBase = selected.url.substring(0, selected.url.lastIndexOf('/') + 1);
      const rewrittenLines = content.split('\n').map((line: string) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('http')) return new URL(trimmed, streamBase).href;
        return line;
      });
      return c.body(rewrittenLines.join('\n'), 200, { 
        'Content-Type': 'application/vnd.apple.mpegurl', 
        'Cache-Control': 'no-cache', 
        'Access-Control-Allow-Origin': '*' 
      });
    }

    // 3. Master M3U8 for ABR
    let masterM3U8 = '#EXTM3U\n#EXT-X-VERSION:3\n';
    allowedStreams.forEach((s: any) => {
      let bandwidth = 800000;
      let resText = '640x480';
      if (s.quality === '1080p') { bandwidth = 5000000; resText = '1920x1080'; }
      else if (s.quality === '720p') { bandwidth = 2800000; resText = '1280x720'; }
      else if (s.quality === '480p') { bandwidth = 1200000; resText = '854x480'; }
      masterM3U8 += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resText},NAME="${s.quality}"\n`;
      masterM3U8 += `${baseUrl}/api/channels/stream?id=${shortId}&res=${s.quality}\n`;
    });

    return c.body(masterM3U8, 200, { 
      'Content-Type': 'application/vnd.apple.mpegurl', 
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) { return c.json({ error: 'Stream controller error' }, 500); }
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
      const item = { 
        ...ch, 
        id: shortId, 
        original_id: ch.id, 
        stream: `${baseUrl}/api/channels/stream?id=${shortId}`, 
        status: status 
      };
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
