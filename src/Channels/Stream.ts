import { Hono } from 'hono';
import axios from 'axios';
import { getOriginalId } from './Utils.js';

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

  try {
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
  } catch (err) {
    console.error('Failed to load stream index:', err);
  }

  return map;
}

/**
 * Robust Manifest Rewriter
 * Handles both Master and Media playlists
 */
function rewriteManifest(content: string, baseUrl: string, channelId: string): string {
  const lines = content.split('\n');
  const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

  return lines.map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;

    // Convert relative to absolute
    let absUrl = t;
    try {
      if (!t.startsWith('http')) {
        absUrl = new URL(t, base).href;
      }
    } catch (e) {
      return line;
    }

    // Proxy everything through our endpoint
    return `/api/channels/stream?id=${channelId}&segment=${encodeURIComponent(absUrl)}`;
  }).join('\n');
}

router.get('/stream', async (c) => {
  const id = c.req.query('id');
  const segment = c.req.query('segment');

  if (!id) return c.json({ error: 'Missing id' }, 400);

  // Resolve shortId to originalId
  const originalId = await getOriginalId(id);

  const streams = await getStreamIndex();
  const list = streams.get(originalId);

  // If no segment is requested, we are fetching the initial manifest
  const targetUrl = segment ? decodeURIComponent(segment) : (list?.[0]?.url);

  if (!targetUrl) {
    return c.json({ error: 'Stream not found' }, 404);
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    const contentType = response.headers.get('Content-Type') || '';
    const isManifest = targetUrl.toLowerCase().includes('.m3u8') || 
                       contentType.includes('mpegurl') || 
                       contentType.includes('application/x-mpegurl');

    if (isManifest) {
      const text = await response.text();
      const rewritten = rewriteManifest(text, targetUrl, id);

      return new Response(rewritten, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    }

    // For segments (binary data)
    return new Response(response.body, {
      headers: {
        'Content-Type': contentType || 'video/MP2T',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes'
      }
    });

  } catch (error: any) {
    console.error(`[Proxy Error] ${targetUrl}:`, error.message);
    return c.json({ error: 'Failed to proxy stream', detail: error.message }, 502);
  }
});

export default router;