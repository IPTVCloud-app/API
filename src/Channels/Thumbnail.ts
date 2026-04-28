import { Hono } from 'hono';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { getOriginalId } from './Channel.js';

const router = new Hono();

// Remote data sources from iptv-org
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';

// Simple cache for logos mapping
let logoIndex: Map<string, string> | null = null;
let lastLoad = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getLogoIndex() {
  const now = Date.now();
  if (logoIndex && (now - lastLoad) < CACHE_TTL) {
    return logoIndex;
  }
  
  try {
    const res = await axios.get(LOGOS_URL);
    const newIndex = new Map<string, string>();
    res.data.forEach((l: any) => {
      if (l.channel && l.url) {
        newIndex.set(l.channel, l.url);
      }
    });
    logoIndex = newIndex;
    lastLoad = now;
    return logoIndex;
  } catch (err) {
    console.error('[Thumbnail] Failed to fetch logos:', err);
    return logoIndex || new Map<string, string>();
  }
}

// Use OS temp directory for caching
const TEMP_DIR = path.join(os.tmpdir(), 'iptvcloud-thumbnails');

// Ensure directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const GITHUB_LOGO_FALLBACK = 'https://raw.githubusercontent.com/iptv-org/iptv/master/assets/logo.png';

// Custom Broken Image SVG (Data URL)
const BROKEN_IMAGE_SVG = Buffer.from(
  `<svg width="400" height="400" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="400" fill="#1A1A1E"/>
    <path d="M145 145L255 255M255 145L145 255" stroke="#34343A" stroke-width="20" stroke-linecap="round"/>
    <circle cx="200" cy="200" r="120" stroke="#34343A" stroke-width="12"/>
  </svg>`
);

/**
 * Thumbnail & Logo Endpoint
 */
router.get('/', async (c) => {
  const shortId = c.req.query('id');
  if (!shortId) return c.json({ error: 'Channel ID required' }, 400);

  const pathName = c.req.path;
  const isLogoMode = pathName.includes('/logo');
  const cacheKey = isLogoMode ? `logo-${shortId}` : `thumb-${shortId}`;
  const thumbPath = path.join(TEMP_DIR, `${cacheKey}.webp`);

  try {
    // 1. Check local cache
    if (fs.existsSync(thumbPath)) {
      const stats = fs.statSync(thumbPath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      if (ageHours < 24) { 
        return c.body(fs.readFileSync(thumbPath), 200, {
          'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400'
        });
      }
    }

    // 2. Resolve IDs
    const originalId = await getOriginalId(shortId);
    const index = await getLogoIndex();
    let logoUrl = index.get(originalId || '') || GITHUB_LOGO_FALLBACK;

    // 3. Fetch with intelligent fallback
    let buffer: Buffer;
    try {
      const response = await axios.get(logoUrl, { 
        responseType: 'arraybuffer', timeout: 10000, 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        validateStatus: (status) => status < 400 // Trigger catch for 402, 403, etc.
      });
      buffer = Buffer.from(response.data);
    } catch (err) {
      // Fallback to GitHub if primary fails
      if (logoUrl !== GITHUB_LOGO_FALLBACK) {
        try {
          const fb = await axios.get(GITHUB_LOGO_FALLBACK, { responseType: 'arraybuffer', timeout: 5000 });
          buffer = Buffer.from(fb.data);
        } catch { return c.body(BROKEN_IMAGE_SVG, 200, { 'Content-Type': 'image/svg+xml' }); }
      } else {
        return c.body(BROKEN_IMAGE_SVG, 200, { 'Content-Type': 'image/svg+xml' });
      }
    }

    // 4. Process with Sharp
    try {
      const sharpInstance = sharp(buffer);
      if (isLogoMode) {
        await sharpInstance.webp({ quality: 95, lossless: true }).toFile(thumbPath);
      } else {
        await sharpInstance.resize(400, 400, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toFile(thumbPath);
      }
      return c.body(fs.readFileSync(thumbPath) as any, 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
    } catch (e) {
      // Return original if sharp fails
      return c.body(buffer as any, 200, { 'Content-Type': 'image/png' });
    }

  } catch (error) {
    return c.body(BROKEN_IMAGE_SVG as any, 200, { 'Content-Type': 'image/svg+xml' });
  }
});

export default router;
