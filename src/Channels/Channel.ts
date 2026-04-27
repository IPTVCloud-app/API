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

/**
 * Build Metadata Lookups
 */
async function getMetadataMaps() {
  const now = Date.now();
  if (metadataMaps && (now - lastIndexLoad) < INDEX_TTL) return metadataMaps;

  try {
    console.log('[Metadata] Loading reference datasets...');
    const [cnt, lng, reg, tz] = await Promise.all([
      axios.get(COUNTRIES_URL).then(r => r.data),
      axios.get(LANGUAGES_URL).then(r => r.data),
      axios.get(REGIONS_URL).then(r => r.data),
      axios.get(TIMEZONES_URL).then(r => r.data)
    ]);

    const countryToTz = new Map<string, string[]>();
    tz.forEach((t: any) => {
      t.countries?.forEach((code: string) => {
        const list = countryToTz.get(code) || [];
        list.push(t.name);
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
 * Quality Weighting for Sorting
 */
const QUALITY_WEIGHTS: Record<string, number> = {
  '1080p': 100,
  '720p': 80,
  '540p': 60,
  '480p': 40,
  'SD': 20
};

function getQualityWeight(q: string): number {
  if (q.includes('4k') || q.includes('2160p')) return 1000;
  return QUALITY_WEIGHTS[q] || 10;
}

/**
 * Lightweight Multi-Stream Indexer
 */
async function getStreamIndex() {
  const now = Date.now();
  if (streamIndex && (now - lastIndexLoad) < INDEX_TTL) return streamIndex;

  console.log('[Streaming] Building multi-stream index...');
  const newIndex = new Map<string, any[]>();
  
  try {
    const response = await axios.get(STREAMS_URL);
    response.data.forEach((s: any) => {
      if (!s.channel) return;
      const list = newIndex.get(s.channel) || [];
      list.push({ 
        url: s.url, 
        quality: s.quality || 'SD',
        user_agent: s.user_agent || null,
        label: s.label || null
      });
      newIndex.set(s.channel, list);
    });
    
    // Sort all stream lists by quality descending
    for (const [id, streams] of newIndex.entries()) {
      newIndex.set(id, streams.sort((a, b) => getQualityWeight(b.quality) - getQualityWeight(a.quality)));
    }

    streamIndex = newIndex;
    lastIndexLoad = now;
    return streamIndex;
  } catch (err) {
    return streamIndex || new Map();
  }
}

/**
 * Manual Streaming JSON Parser (Early Exit)
 */
async function fetchChannelsSegmented(offset: number, limit: number, baseUrl: string) {
  const streams = await getStreamIndex();
  const meta = await getMetadataMaps();
  
  const response = await axios({
    method: 'get',
    url: CHANNELS_URL,
    responseType: 'stream'
  });

  const stream = response.data as Readable;
  const results: any[] = [];
  let currentObject = '';
  let bracketDepth = 0;
  let objectsSkipped = 0;
  let inString = false;
  let isEscaped = false;

  return new Promise<any[]>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
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
            if (objectsSkipped < offset) {
              objectsSkipped++;
            } else {
              try {
                const ch = JSON.parse(currentObject);
                const countryInfo = meta.countries.get(ch.country);
                const chStreams = streams.get(ch.id) || [];
                
                // Identify "Highest allowed" (Cap at 1080p)
                const allowedStreams = chStreams.filter(s => getQualityWeight(s.quality) <= 100);
                const highestQuality = allowedStreams.length > 0 ? allowedStreams[0].quality : 'N/A';

                results.push({
                  id: ch.id,
                  name: ch.name,
                  alt_names: ch.alt_names || [],
                  network: ch.network,
                  owners: ch.owners || [],
                  country: ch.country,
                  country_name: countryInfo?.name || ch.country,
                  region: countryInfo?.region || null,
                  city: ch.city || null,
                  subdivision: ch.subdivision || null,
                  broadcast_area: ch.broadcast_area || [],
                  languages: ch.languages || [],
                  languages_names: ch.languages?.map((l: any) => meta.languages.get(l)).filter(Boolean) || [],
                  categories: ch.categories || [],
                  timezones: meta.timezones.get(ch.country) || [],
                  website: ch.website,
                  launched: ch.launched,
                  closed: ch.closed,
                  replaced_by: ch.replaced_by,
                  is_nsfw: ch.is_nsfw,
                  logo: ch.logo,
                  format: ch.format || null,
                  geo_blocked: chStreams.some(s => s.label?.toLowerCase().includes('geo-blocked')),
                  highest_allowed_quality: highestQuality,
                  available_streams: allowedStreams.length
                });
                
                if (results.length >= limit) {
                  stream.destroy();
                  resolve(results);
                  return;
                }
              } catch (e) {}
            }
          }
        } else if (bracketDepth > 0) {
          currentObject += char;
        }
      }
    });
    stream.on('end', () => resolve(results));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * ABR Stream Controller (Strict <= 1080p)
 */
router.get('/stream', async (c) => {
  const shortId = c.req.query('id');
  const resolution = c.req.query('res');
  
  if (!shortId) return c.json({ error: 'ID required' }, 400);

  try {
    const originalId = await getOriginalId(shortId);
    const streams = await getStreamIndex();
    const chStreams = streams.get(originalId || shortId) || [];

    // Filter to only allow 1080p and lower
    const allowedStreams = chStreams.filter(s => getQualityWeight(s.quality) <= 100);

    if (allowedStreams.length === 0) {
      return c.json({ 
        code: 403, 
        message: 'No supported streams (max 1080p) available for this channel.' 
      }, 403);
    }

    const highestAvailable = allowedStreams[0]; // Already sorted descending

    // 1. If resolution requested, validate and proxy
    if (resolution) {
      if (getQualityWeight(resolution) > getQualityWeight(highestAvailable.quality)) {
        return c.json({ 
          code: 403, 
          message: `Requested resolution ${resolution} is higher than the original stream (${highestAvailable.quality}).` 
        }, 403);
      }

      const selected = allowedStreams.find(s => s.quality === resolution) || highestAvailable;
      const streamUrl = selected.url;
      const userAgent = selected.user_agent || 'Mozilla/5.0';
      
      const response = await axios.get(streamUrl, {
        responseType: 'text',
        headers: { 'User-Agent': userAgent }
      });

      let content = response.data;
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const rewrittenLines = content.split('\n').map((line: string) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('http')) {
          return new URL(trimmed, baseUrl).href;
        }
        return line;
      });

      return c.body(rewrittenLines.join('\n'), 200, {
        'Content-Type': 'application/x-mpegURL',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
    }

    // 2. Return ABR Master M3U8 (Highest detected and lower only)
    let masterM3U8 = '#EXTM3U\n#EXT-X-VERSION:3\n';
    allowedStreams.forEach(s => {
      let bandwidth = 800000;
      let resText = '640x480';
      
      if (s.quality === '1080p') { bandwidth = 5000000; resText = '1920x1080'; }
      else if (s.quality === '720p') { bandwidth = 2800000; resText = '1280x720'; }
      else if (s.quality === '480p') { bandwidth = 1200000; resText = '854x480'; }
      
      masterM3U8 += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resText},NAME="${s.quality}"\n`;
      masterM3U8 += `/api/channels/stream?id=${shortId}&res=${s.quality}\n`;
    });

    return c.body(masterM3U8, 200, {
      'Content-Type': 'application/x-mpegURL',
      'Cache-Control': 'no-cache'
    });

  } catch (error) {
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
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 500);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const protocol = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host');
  const baseUrl = `${protocol}://${host}`;
  
  try {
    const enrichedSlice = await fetchChannelsSegmented(offset, limit, baseUrl);
    const results = await Promise.all(enrichedSlice.map(async (ch: any) => {
      const shortId = await getShortId(ch.id);
      return {
        ...ch,
        id: shortId,
        original_id: ch.id,
        stream: `${baseUrl}/api/channels/stream?id=${shortId}`
      };
    }));
    return c.json(results);
  } catch (error: any) {
    return c.json({ code: 500, message: 'Streaming error', detail: error.message }, 500);
  }
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.redirect(`/api/channels/stream?id=${id}`);
});

export default router;
