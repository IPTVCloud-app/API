import { Hono } from 'hono';
import sharp from 'sharp';
import axios from 'axios';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const GITHUB_LOGO_FALLBACK = 'https://raw.githubusercontent.com/iptv-org/iptv/master/assets/logo.png';
type LogoItem = { channel?: string; url?: string };

let logoIndex: Map<string, string> | null = null;
let lastLoad = 0;
const LOGO_INDEX_CACHE_TTL = 1000 * 60 * 60;

const THUMB_CACHE_TTL = 1000 * 60 * 60 * 24;
const MAX_THUMB_CACHE_ENTRIES = 2000;
const thumbCache = new Map<string, { data: Buffer; contentType: string; expiresAt: number }>();

async function getLogoIndex() {
  const now = Date.now();
  if (logoIndex && now - lastLoad < LOGO_INDEX_CACHE_TTL) return logoIndex;
  try {
    const res = await axios.get(LOGOS_URL);
    const items = Array.isArray(res.data) ? (res.data as LogoItem[]) : [];
    const next = new Map<string, string>();
    items.forEach((item) => {
      if (item.channel && item.url) next.set(item.channel, item.url);
    });
    logoIndex = next;
    lastLoad = now;
    return logoIndex;
  } catch {
    return logoIndex || new Map<string, string>();
  }
}

function setCachedThumbnail(id: string, data: Buffer, contentType: string) {
  thumbCache.set(id, {
    data,
    contentType,
    expiresAt: Date.now() + THUMB_CACHE_TTL,
  });

  while (thumbCache.size > MAX_THUMB_CACHE_ENTRIES) {
    const firstKey = thumbCache.keys().next().value;
    if (!firstKey) break;
    thumbCache.delete(firstKey);
  }
}

function binaryImageResponse(data: Buffer, contentType: string) {
  const payload = new Uint8Array(data);
  return new Response(payload, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

const BROKEN_IMAGE_SVG = Buffer.from(
  `<svg width="400" height="400" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="400" fill="#1A1A1E"/>
    <path d="M145 145L255 255M255 145L145 255" stroke="#34343A" stroke-width="20" stroke-linecap="round"/>
    <circle cx="200" cy="200" r="120" stroke="#34343A" stroke-width="12"/>
  </svg>`
);

router.get('/', async (c) => {
  const shortId = c.req.query('id');
  if (!shortId) return c.json({ error: 'Channel ID required' }, 400);

  const cached = thumbCache.get(shortId);
  if (cached && cached.expiresAt > Date.now()) {
    return binaryImageResponse(cached.data, cached.contentType);
  }
  if (cached && cached.expiresAt <= Date.now()) {
    thumbCache.delete(shortId);
  }

  try {
    const originalId = await getOriginalId(shortId);
    let buffer: Buffer | null = null;
    let contentType = 'image/png';

    if (originalId) {
      try {
        const epgThumbUrl = `https://iptvcloud-app.github.io/EPG/thumbnails/${originalId}.webp`;
        const response = await axios.get(epgThumbUrl, {
          responseType: 'arraybuffer',
          timeout: 5000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        buffer = Buffer.from(response.data);
        contentType = 'image/webp';
      } catch {
        // fall through to logo source
      }
    }

    if (!buffer) {
      const index = await getLogoIndex();
      const logoUrl = index.get(originalId || '') || GITHUB_LOGO_FALLBACK;
      try {
        const response = await axios.get(logoUrl, {
          responseType: 'arraybuffer',
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        buffer = Buffer.from(response.data);
        contentType = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : 'image/png';
      } catch {
        return c.body(BROKEN_IMAGE_SVG, 200, { 'Content-Type': 'image/svg+xml' });
      }
    }

    try {
      const webpBuffer = await sharp(buffer).webp({ quality: 80 }).toBuffer();
      setCachedThumbnail(shortId, webpBuffer, 'image/webp');
      return binaryImageResponse(webpBuffer, 'image/webp');
    } catch {
      setCachedThumbnail(shortId, buffer, contentType);
      return binaryImageResponse(buffer, contentType);
    }
  } catch {
    return c.body(BROKEN_IMAGE_SVG, 200, { 'Content-Type': 'image/svg+xml' });
  }
});

export default router;
