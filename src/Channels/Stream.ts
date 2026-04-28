import { Hono, Context } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
import { stream as honoStream } from 'hono/streaming';
// @ts-expect-error mux.js has no official types
import muxjs from 'mux.js';
import { getOriginalId } from './Utils.js';

/* -------------------------------------------------------
   TYPES
------------------------------------------------------- */
interface StreamSource {
  url: string;
  quality: string;
  user_agent: string | null;
  channel?: string;
  label?: string | null;
}

type QueueItem = {
  url: string;
  data: Buffer | null;
};

/* -------------------------------------------------------
   CONSTANTS
------------------------------------------------------- */
const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

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
   STREAM INDEX CACHE
------------------------------------------------------- */
let streamIndex: Map<string, StreamSource[]> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60;

export async function getStreamIndex(): Promise<Map<string, StreamSource[]>> {
  const now = Date.now();
  if (streamIndex && now - lastIndexLoad < INDEX_TTL) return streamIndex;

  try {
    const { data } = await axios.get<StreamSource[]>(STREAMS_URL, { timeout: 10000 });

    const map = new Map<string, StreamSource[]>();

    for (const s of data) {
      if (!s.channel || !s.url) continue;

      const key = String(s.channel).toLowerCase();
      const list = map.get(key) || [];

      list.push({
        url: s.url,
        quality: s.quality || 'SD',
        user_agent: s.user_agent || null,
        label: s.label || null
      });

      map.set(key, list);
    }

    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => getQualityWeight(b.quality) - getQualityWeight(a.quality));
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
   STATUS CACHE
------------------------------------------------------- */
const statusCache = new Map<string, { status: string; time: number }>();
const STATUS_TTL = 1000 * 60 * 5;

async function checkStreamStatus(url: string, ua: string): Promise<string> {
  if (!url) return 'offline';

  const cached = statusCache.get(url);
  if (cached && Date.now() - cached.time < STATUS_TTL) return cached.status;

  try {
    const res = await axios.head(url, {
      timeout: 2000,
      headers: { 'User-Agent': ua },
      validateStatus: (s) => s >= 200 && s < 500
    });

    let status = 'offline';
    if (res.status === 403) status = 'geo-blocked';
    else if (res.status < 400) status = 'online';

    statusCache.set(url, { status, time: Date.now() });
    return status;

  } catch {
    statusCache.set(url, { status: 'offline', time: Date.now() });
    return 'offline';
  }
}

/* -------------------------------------------------------
   RELAY STREAM (FIXED)
------------------------------------------------------- */
async function relayStream(c: Context, selected: StreamSource) {
  const ua = selected.user_agent || 'Mozilla/5.0';

  const status = await checkStreamStatus(selected.url, ua);

  if (status === 'geo-blocked') {
    throw new HTTPException(403, {
      message: 'Stream is geo-blocked. Use VPN or another source.'
    });
  }

  if (status === 'offline') {
    throw new HTTPException(404, { message: 'Stream offline' });
  }

  c.header('Content-Type', 'video/mp4');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return honoStream(c, async (stream) => {
  const Transmuxer = (muxjs as any).mp4.Transmuxer;

  const transmuxer = new Transmuxer({
    keepOriginalTimestamps: true,
    baseMediaDecodeTime: 0
  });

  let initSent = false;
  let closed = false;

  const queue: QueueItem[] = [];
  const sent = new Set<string>();
  const MAX_QUEUE = 5;

  let processing = false;

  transmuxer.on('data', (ev: any) => {
    if (!initSent && ev.initSegment) {
      stream.write(ev.initSegment);
      initSent = true;
    }
    if (ev.data) stream.write(ev.data);
  });

  stream.onAbort(() => {
    closed = true;
    transmuxer.dispose();
  });

  const fetchPlaylist = async () => {
    try {
      const res = await axios.get<string>(selected.url, {
        headers: { 'User-Agent': ua },
        timeout: 4000,
        responseType: 'text'
      });

      const base = selected.url.substring(0, selected.url.lastIndexOf('/') + 1);

      return res.data
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => {
          try {
            return new URL(l, base).href;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as string[];

    } catch {
      return [];
    }
  };

  const fillQueue = async () => {
    if (closed) return;

    const segments = await fetchPlaylist();

    for (const seg of segments) {
      if (closed) break;
      if (sent.has(seg)) continue;
      if (queue.length >= MAX_QUEUE) break;
      if (queue.some(q => q.url === seg)) continue;

      const item: QueueItem = { url: seg, data: null };
      queue.push(item);

      axios.get<ArrayBuffer>(seg, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': ua },
        timeout: 8000
      }).then(res => {
        if (!closed) item.data = Buffer.from(res.data);
      }).catch(() => {});
    }
  };

  const processQueue = async () => {
    if (processing) return;
    processing = true;

    try {
      const item = queue.shift();
      if (!item?.data) return;

      transmuxer.push(new Uint8Array(item.data));
      sent.add(item.url);

      if (sent.size > 60) {
        const first = sent.values().next().value;
        if (first) sent.delete(first);
      }

    } finally {
      processing = false;
    }
  };

  // 🔥 heartbeat prevents gateway timeout
  const heartbeat = setInterval(() => {
    if (closed) return clearInterval(heartbeat);
    stream.write(new Uint8Array([0])); // keep-alive byte
  }, 15000);

  const loop = async () => {
    while (!closed) {
      await fillQueue();
      await processQueue();
      await new Promise(r => setTimeout(r, 150));
    }
  };

  loop();

  stream.onAbort(() => {
    closed = true;
    clearInterval(heartbeat);
    transmuxer.dispose();
  });
});
}

/* -------------------------------------------------------
   ENTRY ROUTE
------------------------------------------------------- */
const router = new Hono();

router.get('/', async (c) => {
  const id = c.req.query('id');
  const res = c.req.query('res');

  if (!id) throw new HTTPException(400, { message: 'ID required' });

  const original = await getOriginalId(id);
  const key = (original || id).toLowerCase();

  const index = await getStreamIndex();
  let list = index.get(key) || [];

  list = list.filter(s => !isQualityTooHigh(s.quality));

  if (!list.length) {
    throw new HTTPException(404, { message: 'Stream not found' });
  }

  let selected = list[0];

  if (res) {
    const match = list.find(s => s.quality === res);
    if (match) selected = match;
  }

  return relayStream(c, selected);
});

export default router;