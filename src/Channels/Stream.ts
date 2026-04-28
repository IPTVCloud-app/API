import { Context } from 'hono';
import axios from 'axios';
import { HTTPException } from 'hono/http-exception';
import { stream as honoStream } from 'hono/streaming';
import muxjs from 'mux.js';
import { getOriginalId } from './Utils.js';

export interface StreamSource {
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

async function checkStreamStatus(url: string, ua: string): Promise<string> {
  if (!url) return 'offline';

  try {
    const res = await axios.head(url, {
      timeout: 2000,
      headers: { 'User-Agent': ua },
      validateStatus: (s) => s >= 200 && s < 500
    });

    if (res.status === 403) return 'geo-blocked';
    if (res.status < 400) return 'online';
    return 'offline';

  } catch {
    return 'offline';
  }
}

/* -------------------------------------------------------
   RELAY STREAM (FIXED FOR VERCEL)
------------------------------------------------------- */
export async function relayStream(c: Context, selected: StreamSource) {
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
    const MAX_QUEUE = 3;

    let processing = false;

    /* -------------------------------
       OUTPUT PIPE
    ------------------------------- */
    transmuxer.on('data', (ev: any) => {
      if (!initSent && ev.initSegment) {
        stream.write(ev.initSegment);
        initSent = true;
      }
      if (ev.data) {
        stream.write(ev.data);
      }
    });

    /* -------------------------------
       ABORT CLEANUP
    ------------------------------- */
    stream.onAbort(() => {
      closed = true;
      transmuxer.dispose();
      clearInterval(heartbeat);
    });

    /* -------------------------------
       FETCH PLAYLIST
    ------------------------------- */
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

    /* -------------------------------
       QUEUE BUILDER
    ------------------------------- */
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

    /* -------------------------------
       PROCESS QUEUE (SAFE)
    ------------------------------- */
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

    /* -------------------------------
       🔥 VERCEL HEARTBEAT (CRITICAL FIX)
    ------------------------------- */
    const heartbeat = setInterval(() => {
      if (closed) return clearInterval(heartbeat);
      stream.write(new Uint8Array([0])); // keep-alive
    }, 15000);

    /* -------------------------------
       MAIN LOOP (NON-BLOCKING)
    ------------------------------- */
    const loop = async () => {
      while (!closed) {
        await fillQueue();
        await processQueue();
        await new Promise(r => setTimeout(r, 150));
      }
    };

    loop();
  });
}
