import { Hono } from 'hono';
import axios from 'axios';
import { Readable } from 'stream';
import { getShortId, checkStreamStatus } from './Utils.js';
import { getMetadataMaps } from './Metadata.js';
import { getStreamIndex } from './Stream.js';

const router = new Hono();

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';

const QUALITY_WEIGHTS: Record<string, number> = { '1080p': 100, '720p': 80, '540p': 60, '480p': 40, 'SD': 20 };
const getQualityWeight = (q: string) => QUALITY_WEIGHTS[q] || 10;
const isQualityTooHigh = (q: string) => getQualityWeight(q) > 100;

router.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  
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
      category: category?.toString().toLowerCase(), 
      language: language?.toString().toLowerCase(), 
      country: country?.toString().toLowerCase(), 
      city: city?.toString().toLowerCase(), 
      subdivision: subdivision?.toString().toLowerCase(), 
      region: region?.toString().toLowerCase() 
    };
    
    const channels = await fetchChannelsSegmented(offset, limit, baseUrl, search?.toString(), filters);
    const streams = await getStreamIndex();
    
    const results = await Promise.all(channels.map(async (ch: any) => {
      const shortId = await getShortId(ch.id);
      
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
              
              if (filters.category && !ch.categories?.some((cat: string) => cat.toLowerCase() === filters.category)) continue;
              if (filters.language && !ch.languages?.some((lang: string) => lang.toLowerCase() === filters.language)) continue;
              if (filters.country && ch.country?.toLowerCase() !== filters.country) continue;
              if (filters.city && ch.city?.toLowerCase() !== filters.city) continue;
              if (filters.subdivision && ch.subdivision?.toLowerCase() !== filters.subdivision) continue;
              if (filters.region && meta.countries.get(ch.country)?.region?.toLowerCase() !== filters.region) continue;

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
