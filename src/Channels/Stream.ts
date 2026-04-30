import { Hono } from 'hono';
import axios from 'axios';

const router = new Hono();

const STREAMS_URL = 'https://iptvcloud-app.github.io/EPG/streams.json';

let streamIndex: Map<string, any[]> | null = null;
let lastLoad = 0;
const TTL = 1000 * 60 * 60;

// -------------------------
// STREAM INDEX
// -------------------------
async function getStreamIndex() {
  const now = Date.now();
  if (streamIndex && now - lastLoad < TTL) return streamIndex;

  const map = new Map<string, any[]>();

  const res = await axios.get(STREAMS_URL);
  const data = Array.isArray(res.data) ? res.data : (res.data.streams || []);

  for (const s of data) {
    if (!s.channel) continue;

    const list = map.get(s.channel) || [];
    list.push({ url: s.url });
    map.set(s.channel, list);
  }

  streamIndex = map;
  lastLoad = now;

  return map;
}

router.get('/stream', async (c) => {
  const id = c.req.query('id');
  const segment = c.req.query('segment');

  if (!id) return c.json({ error: 'Missing id' }, 400);

  const streams = await getStreamIndex();
  const list = streams.get(id);

  if (!list?.length) {
    return c.json({ error: 'Stream not found' }, 404);
  }

  const source = list[0].url;

  if (segment) {
    try {
      const url = decodeURIComponent(segment);

      const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      return new Response(res.data, {
        headers: {
          'Content-Type': 'video/MP2T',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=10'
        }
      });
    } catch {
      return c.text('segment error', 500);
    }
  }

  try {
    const res = await axios.get(source, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const base = source.substring(0, source.lastIndexOf('/') + 1);

    const rewritten = res.data
      .split('\n')
      .map((line: string) => {
        const t = line.trim();

        if (!t || t.startsWith('#')) return line;

        const abs = t.startsWith('http')
          ? t
          : new URL(t, base).href;
        return `/api/channels/stream?id=${id}&segment=${encodeURIComponent(abs)}`;
      });

    return new Response(rewritten.join('\n'), {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      }
    });

  } catch {
    return c.json({ error: 'manifest failed' }, 500);
  }
});

export default router;