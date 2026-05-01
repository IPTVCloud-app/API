import { Hono } from 'hono';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const GITHUB_LOGO_FALLBACK = 'https://raw.githubusercontent.com/iptv-org/iptv/master/assets/logo.png';
const TEMP_DIR = path.join(os.tmpdir(), 'iptvcloud-thumbnails');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let logoIndex: Map<string, string> | null = null;
let lastLoad = 0;
const CACHE_TTL = 1000 * 60 * 60;

async function getLogoIndex() {
  const now = Date.now();
  if (logoIndex && (now - lastLoad) < CACHE_TTL) return logoIndex;
  try {
    const res = await axios.get(LOGOS_URL);
    const newIndex = new Map<string, string>();
    res.data.forEach((l: any) => { if (l.channel && l.url) newIndex.set(l.channel, l.url); });
    logoIndex = newIndex;
    lastLoad = now;
    return logoIndex;
  } catch (err) { return logoIndex || new Map(); }
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

  const thumbPath = path.join(TEMP_DIR, `thumb-${shortId}.webp`);

  try {
    if (fs.existsSync(thumbPath)) {
      const stats = fs.statSync(thumbPath);
      if ((Date.now() - stats.mtimeMs) < 86400000) { 
        return c.body(fs.readFileSync(thumbPath), 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      }
    }

    const originalId = await getOriginalId(shortId);
    
    let buffer: Buffer | null = null;

    // 1. Try fetching EPG thumbnail first
    if (originalId) {
      try {
        const epgThumbUrl = `https://iptvcloud-app.github.io/EPG/thumbnails/${originalId}.webp`;
        const response = await axios.get(epgThumbUrl, { responseType: 'arraybuffer', timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        buffer = Buffer.from(response.data);
      } catch (err) {
        // EPG thumbnail failed (e.g. 404), fall through to logo
      }
    }

    // 2. Fallback to logo API
    if (!buffer) {
      const index = await getLogoIndex();
      const logoUrl = index.get(originalId || '') || GITHUB_LOGO_FALLBACK;

      try {
        const response = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        buffer = Buffer.from(response.data);
      } catch (err) {
        return c.body(BROKEN_IMAGE_SVG, 200, { 'Content-Type': 'image/svg+xml' });
      }
    }

    try {
      await sharp(buffer).resize(400, 400, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toFile(thumbPath);
      return c.body(fs.readFileSync(thumbPath) as any, 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
    } catch (e) {
      return c.body(buffer as any, 200, { 'Content-Type': 'image/png' });
    }
  } catch (error) {
    return c.body(BROKEN_IMAGE_SVG as any, 200, { 'Content-Type': 'image/svg+xml' });
  }
});

export default router;
