import { Hono } from 'hono';
import axios from 'axios';
import { Readable } from 'stream';
import { getShortId, checkStreamStatus } from './Utils.js';
import { getMetadataMaps } from './Metadata.js';
import { getStreamIndex } from './Stream.js';

const router = new Hono();

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';

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
   STATUS CACHE (FIX FOR SLOW + FALSE RESULTS)
------------------------------------------------------- */
const statusCache = new Map<string, { status: string; time: number }>();
const STATUS_TTL = 1000 * 60 * 5; // 5 min cache

async function getCachedStatus(url: string): Promise<string> {
  if (!url) return 'offline';

  const now = Date.now();
  const cached = statusCache.get(url);

  if (cached && now - cached.time < STATUS_TTL) {
    return cached.status;
  }

  const status = await checkStreamStatus(url);

  statusCache.set(url, {
    status,
    time: now
  });

  return status;
}

/* -------------------------------------------------------
   STREAM INDEX PARSER (UNTOUCHED LOGIC, FIXED STATUS USAGE)
------------------------------------------------------- */
async function fetchChannelsSegmented(
  offset: number,
  limit: number,
  search?: string,
  filters: any = {}
) {
  const streams = await getStreamIndex();
  const meta = await getMetadataMaps();
  const searchLower = search?.toLowerCase();

  const response = await axios({
    method: 'get',
    url: CHANNELS_URL,
    responseType: 'stream'
  });

  const streamData = response.data as Readable;

  const results: any[] = [];
  let currentObject = '';
  let bracketDepth = 0;
  let matchesFound = 0;
  let inString = false;
  let isEscaped = false;

  for await (const chunk of streamData) {
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

      if (char === '"') {
        inString = true;
        currentObject += char;
        continue;
      }

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

            const chStreams = streams.get(ch.id.toLowerCase()) || [];

            /* -------------------------------------------------------
               PRIMARY STREAM (IMPORTANT FIX)
            ------------------------------------------------------- */
            const primaryStream =
              chStreams.find((s: any) => !isQualityTooHigh(s.quality)) ||
              chStreams[0];

            const primaryUrl = primaryStream?.url;

            /* -------------------------------------------------------
               FILTERS
            ------------------------------------------------------- */

            if (filters.category &&
                !ch.categories?.some((c: string) => c.toLowerCase() === filters.category)) continue;

            if (filters.language &&
                !ch.languages?.some((l: string) => l.toLowerCase() === filters.language)) continue;

            if (filters.country &&
                ch.country?.toLowerCase() !== filters.country) continue;

            if (filters.city &&
                ch.city?.toLowerCase() !== filters.city) continue;

            if (filters.subdivision &&
                ch.subdivision?.toLowerCase() !== filters.subdivision) continue;

            if (filters.region &&
                meta.countries.get(ch.country)?.region?.toLowerCase() !== filters.region) continue;

            /* -------------------------------------------------------
               SEARCH FILTER
            ------------------------------------------------------- */
            const matchesSearch =
              !searchLower ||
              ch.name?.toLowerCase().includes(searchLower) ||
              ch.id?.toLowerCase().includes(searchLower) ||
              ch.country?.toLowerCase().includes(searchLower) ||
              ch.city?.toLowerCase().includes(searchLower) ||
              ch.categories?.some((c: string) => c.toLowerCase().includes(searchLower));

            if (!matchesSearch) continue;

            /* -------------------------------------------------------
               STATUS FILTER (FIXED LOGIC)
            ------------------------------------------------------- */
            let statusValue: string | null = null;

            if (filters.status) {
              statusValue = await getCachedStatus(primaryUrl);

              // 🔥 FIX: prevents offline leaks
              if (statusValue !== filters.status) continue;
            }

            /* -------------------------------------------------------
               PAGINATION
            ------------------------------------------------------- */
            if (matchesFound < offset) {
              matchesFound++;
              continue;
            }

            matchesFound++;

            const allowed = chStreams.filter((s: any) => !isQualityTooHigh(s.quality));

            const langNames =
              ch.languages?.map((l: any) => meta.languages.get(l)).filter(Boolean) || [];

            results.push({
              ...ch,
              country_name: meta.countries.get(ch.country)?.name || null,
              region: meta.countries.get(ch.country)?.region || null,
              languages_names: langNames,
              available_resolutions: allowed.map((s: any) => s.quality),
              status: statusValue
            });

            if (results.length >= limit) {
              streamData.destroy();
              return results;
            }
          } catch (e) {}
        }
      } else if (bracketDepth > 0) {
        currentObject += char;
      }
    }
  }

  return results;
}

/* -------------------------------------------------------
   MAIN ROUTE
------------------------------------------------------- */
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
  const country = getParam('country');
  const category = getParam('category');
  const language = getParam('language');
  const city = getParam('city');
  const subdivision = getParam('subdivision');
  const region = getParam('region');
  const status = getParam('status');

  const protocol = c.req.header('x-forwarded-proto') || 'http';
  const baseUrl = `${protocol}://${c.req.header('host')}`;

  try {
    const filters = {
      country: country?.toString().toLowerCase(),
      category: category?.toString().toLowerCase(),
      language: language?.toString().toLowerCase(),
      city: city?.toString().toLowerCase(),
      subdivision: subdivision?.toString().toLowerCase(),
      region: region?.toString().toLowerCase(),
      status: status?.toString().toLowerCase()
    };

    const channels = await fetchChannelsSegmented(offset, limit, search?.toString(), filters);
    const streams = await getStreamIndex();

    const results = await Promise.all(
      channels.map(async (ch: any) => {
        const shortId = await getShortId(ch.id);

        const chStreams = streams.get(ch.id.toLowerCase()) || [];

        const allowed = chStreams.filter(
          (s: any) => !isQualityTooHigh(s.quality)
        );

        const primaryUrl = allowed[0]?.url || chStreams[0]?.url;

        // ⚡ cached status (no more false results or slow HEAD spam)
        const statusValue = await getCachedStatus(primaryUrl);

        return {
          ...ch,
          id: shortId,
          original_id: ch.id,
          stream: `${baseUrl}/api/channels/stream?id=${shortId}`,
          thumbnail: `${baseUrl}/api/channels/thumbnail?id=${shortId}`,
          logo: `${baseUrl}/api/channels/logo?id=${shortId}`,
          status: statusValue,
          available_resolutions: allowed.map((s: any) => s.quality),
          abr_supported: allowed.length > 1
        };
      })
    );

    let final = results;

    if (status) {
      final = results.filter((r) => r.status === status);
    }

    return c.json(final);
  } catch (error) {
    return c.json({ error: 'List error' }, 500);
  }
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  return c.redirect(`/api/channels/stream?id=${id}`);
});

export default router;