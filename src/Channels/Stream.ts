import { Hono } from 'hono';
import axios from 'axios';
// @ts-expect-error
import muxjs from 'mux.js';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

/* -------------------------------------------------------
   STREAM INDEX CACHE
------------------------------------------------------- */
let streamIndex: Map<string, any[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60;

const QUALITY_WEIGHTS: Record<string, number> = {
  '1080p': 100,
  '720p': 80,
  '540p': 60,
  '480p': 40,
  'SD': 20
};

function getQualityWeight(q: string) {
  return QUALITY_WEIGHTS[q] || 10;
}

function isQualityTooHigh(q: string) {
  return getQualityWeight(q) > 100;
}

async function getStreamIndex() {
  const now = Date.now();

  if (streamIndex && now - lastIndexLoad < INDEX_TTL) {
    return streamIndex;
  }

  const map = new Map<string, any[]>();

  try {
    const { data } = await axios.get(STREAMS_URL, { timeout: 10000 });

    data.forEach((s: any) => {
      if (!s.channel) return;

      const key = String(s.channel).toLowerCase();

      const arr = map.get(key) || [];

      arr.push({
        url: s.url,
        quality: s.quality || 'SD',
        user_agent: s.user_agent || null
      });

      map.set(key, arr);
    });

    for (const [k, arr] of map.entries()) {
      arr.sort(
        (a, b) => getQualityWeight(b.quality) - getQualityWeight(a.quality)
      );
      map.set(k, arr);
    }

    streamIndex = map;
    lastIndexLoad = now;

    return map;
  } catch {
    return streamIndex || new Map();
  }
}

/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

async function fetchText(url: string, ua: string) {
  const { data } = await axios.get(url, {
    timeout: 8000,
    responseType: 'text',
    headers: { 'User-Agent': ua }
  });

  return data as string;
}

async function resolveMediaPlaylist(url: string, ua: string) {
  const text = await fetchText(url, ua);

  // already media playlist
  if (text.includes('#EXT-X-TARGETDURATION')) {
    return {
      url,
      content: text
    };
  }

  // master playlist
  const lines = text.split('\n');

  const picked = lines.find(
    (l) =>
      l.trim() &&
      !l.startsWith('#') &&
      l.toLowerCase().includes('.m3u8')
  );

  if (!picked) {
    return {
      url,
      content: text
    };
  }

  const nextUrl = picked.startsWith('http')
    ? picked.trim()
    : new URL(picked.trim(), url).href;

  return {
    url: nextUrl,
    content: await fetchText(nextUrl, ua)
  };
}

function parsePlaylist(content: string, baseUrl: string) {
  const lines = content.split('\n');

  let targetDuration = 6;
  let mediaSequence = 0;
  let duration = 6;
  let seq = 0;

  const segments: {
    url: string;
    duration: number;
    seq: number;
  }[] = [];

  for (const line of lines) {
    const l = line.trim();

    if (!l) continue;

    if (l.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(l.split(':')[1]) || 6;
    } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(l.split(':')[1]) || 0;
      seq = mediaSequence;
    } else if (l.startsWith('#EXTINF:')) {
      duration = parseFloat(l.split(':')[1]) || 6;
    } else if (!l.startsWith('#')) {
      const abs = l.startsWith('http')
        ? l
        : new URL(l, baseUrl).href;

      segments.push({
        url: abs,
        duration,
        seq: seq++
      });
    }
  }

  return {
    targetDuration,
    mediaSequence,
    segments
  };
}

async function fetchSegment(url: string, ua: string) {
  const { data } = await axios.get(url, {
    timeout: 12000,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': ua }
  });

  return new Uint8Array(data);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------
   LIVE STREAM ROUTE
------------------------------------------------------- */

router.get('/', async (c) => {
  const id = c.req.query('id');
  const res = c.req.query('res') || 'auto';

  if (!id) {
    return c.json({ error: 'ID required' }, 400);
  }

  try {
    const originalId = await getOriginalId(id);
    const searchId = (originalId || id).toLowerCase();

    const index = await getStreamIndex();
    let list = index.get(searchId) || [];

    if (!list.length) {
      return c.json({ error: 'No streams found' }, 404);
    }

    let allowed = list.filter((s) => !isQualityTooHigh(s.quality));
    if (!allowed.length) allowed = list;

    let selected = allowed[0];

    if (res !== 'auto') {
      const found = allowed.find((s) => s.quality === res);
      if (found) selected = found;
    }

    const ua = selected.user_agent || 'Mozilla/5.0';

    const status = await axios
      .head(selected.url, {
        timeout: 3000,
        headers: { 'User-Agent': ua },
        validateStatus: (s) => s >= 200 && s < 500
      })
      .then((r) =>
        r.status === 403
          ? 'geo-blocked'
          : r.status < 400
          ? 'online'
          : 'offline'
      )
      .catch(() => 'online');

    if (status === 'geo-blocked') {
      return c.json({ error: 'Geo blocked' }, 403);
    }

    const signal = c.req.raw.signal;

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;

        signal.addEventListener('abort', () => {
          closed = true;
          try {
            controller.close();
          } catch {}
        });

        const transmuxer = new muxjs.mp4.Transmuxer({
          keepOriginalTimestamps: true
        });

        let initSent = false;

        transmuxer.on('data', (segment: any) => {
          if (closed) return;

          try {
            // send init only once
            if (!initSent && segment.initSegment) {
              controller.enqueue(
                new Uint8Array(segment.initSegment)
              );
              initSent = true;
            }

            if (segment.data) {
              controller.enqueue(
                new Uint8Array(segment.data)
              );
            }
          } catch {
            closed = true;
          }
        });

        let mediaUrl = selected.url;
        let lastSeq = -1;

        try {
          while (!closed) {
            const playlist = await resolveMediaPlaylist(
              mediaUrl,
              ua
            );

            mediaUrl = playlist.url;

            const baseUrl = mediaUrl.substring(
              0,
              mediaUrl.lastIndexOf('/') + 1
            );

            const parsed = parsePlaylist(
              playlist.content,
              baseUrl
            );

            // IMPORTANT:
            // if first boot, start from last 2 segments
            let fresh = parsed.segments.filter(
              (s) => s.seq > lastSeq
            );

            if (lastSeq === -1 && fresh.length > 2) {
              fresh = fresh.slice(-2);
            }

            if (fresh.length) {
              for (const seg of fresh) {
                if (closed) break;

                try {
                  const bytes = await fetchSegment(
                    seg.url,
                    ua
                  );

                  transmuxer.push(bytes);
                  transmuxer.flush();

                  lastSeq = seg.seq;
                } catch {
                  // skip bad segment
                }
              }
            }

            // wait for next live update
            const wait =
              Math.max(
                1000,
                (parsed.targetDuration * 1000) / 2
              );

            await sleep(wait);
          }
        } catch (err) {
          if (!closed) {
            try {
              controller.error(err);
            } catch {}
          }
        } finally {
          try {
            transmuxer.dispose();
          } catch {}
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control':
          'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch {
    return c.json({ error: 'Stream failure' }, 500);
  }
});

export default router;