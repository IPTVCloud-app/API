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

/**
 * Thumbnail & Logo Endpoint
 * Differentiates between 'thumbnail' (optimized for grids) and 'logo' (high quality for branding)
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
        const fileBuffer = fs.readFileSync(thumbPath);
        return c.body(fileBuffer, 200, {
          'Content-Type': 'image/webp',
          'Cache-Control': 'public, max-age=86400'
        });
      }
    }

    // 2. Resolve Original ID
    const originalId = await getOriginalId(shortId);
    if (!originalId) return c.json({ error: 'Channel not found' }, 404);

    // 3. Find Logo URL from IPTV-org index
    const index = await getLogoIndex();
    const logoUrl = index.get(originalId);
    
    if (!logoUrl) {
      return c.redirect('https://raw.githubusercontent.com/iptv-org/iptv/master/assets/logo.png');
    }

    // 4. Fetch and Process
    const response = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 5000 });
    const buffer = Buffer.from(response.data);

    const sharpInstance = sharp(buffer);
    
    if (isLogoMode) {
      // 1. High Quality Logo - NO RESIZING
      // We only convert to WebP and optimize to prevent ANY distortion
      await sharpInstance
        .webp({ quality: 95, lossless: true }) // Higher quality, preserving every detail
        .toFile(thumbPath);
    } else {
      // 2. Optimized Thumbnail - PRESERVE ASPECT RATIO
      // We use 'contain' with a transparent background so the logo is NEVER stretched or cropped
      await sharpInstance
        .resize(400, 400, { 
          fit: 'contain', 
          background: { r: 0, g: 0, b: 0, alpha: 0 } 
        })
        .webp({ quality: 80 })
        .toFile(thumbPath);
    }

    const fileBuffer = fs.readFileSync(thumbPath);
    return c.body(fileBuffer, 200, {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=86400'
    });

  } catch (error) {
    console.error('Image processing error:', error);
    return c.json({ error: 'Failed to process image' }, 500);
  }
});

export default router;
