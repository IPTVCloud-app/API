import { Hono } from 'hono';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getOriginalId } from './Utils.js';

const router = new Hono();

const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const GITHUB_LOGO_FALLBACK = 'https://raw.githubusercontent.com/iptv-org/iptv/master/assets/logo.png';

let logoIndex: Map<string, string> | null = null;
let lastLoad = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

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
  } catch (err) { return logoIndex || new Map<string, string>(); }
}

const BROKEN_IMAGE_SVG = Buffer.from(
  `<svg width="400" height="400" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="400" fill="#1A1A1E"/>
    <path d="M145 145L255 255M255 145L145 255" stroke="#34343A" stroke-width="20" stroke-linecap="round"/>
    <circle cx="200" cy="200" r="120" stroke="#34343A" stroke-width="12"/>
  </svg>`
);

const logoCache = new Map<string, { data: any, contentType: string, time: number }>();
const LOGO_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

router.get('/', async (c) => {
  const shortId = c.req.query('id');
  if (!shortId) return c.json({ error: 'Channel ID required' }, 400);

  const cached = logoCache.get(shortId);
  if (cached && (Date.now() - cached.time) < LOGO_CACHE_TTL) {
    return c.body(cached.data, 200, { 'Content-Type': cached.contentType, 'Cache-Control': 'public, max-age=86400' });
  }

  try {
    const originalId = await getOriginalId(shortId);
    const index = await getLogoIndex();
    const logoUrl = index.get(originalId || '') || GITHUB_LOGO_FALLBACK;

    try {
      const response = await axios.get(logoUrl, { 
        responseType: 'arraybuffer', timeout: 8000, 
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const contentType = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : 'image/png';
      
      logoCache.set(shortId, { data: response.data, contentType, time: Date.now() });
      if (logoCache.size > 2000) {
        const firstKey = logoCache.keys().next().value;
        if (firstKey !== undefined) logoCache.delete(firstKey);
      }

      return c.body(response.data, 200, { 
        'Content-Type': contentType, 
        'Cache-Control': 'public, max-age=86400' 
      });
    } catch (err) {
      return c.body(BROKEN_IMAGE_SVG, 200, { 'Content-Type': 'image/svg+xml' });
    }
  } catch (error) {
    return c.body(BROKEN_IMAGE_SVG, 200, { 'Content-Type': 'image/svg+xml' });
  }
});

export default router;
