import { Hono } from 'hono';
import axios from 'axios';
import sharp from 'sharp';
import { nanoid } from 'nanoid';

const router = new Hono();

// In-memory store for image URL mappings with expiration
interface StoredUrl {
  url: string;
  expiresAt: number;
}
const urlMap = new Map<string, StoredUrl>();

// 1 Hour in milliseconds
const EXPIRATION_TIME = 60 * 60 * 1000;

// Cleanup interval to remove expired entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of urlMap.entries()) {
    if (now > data.expiresAt) {
      urlMap.delete(id);
    }
  }
}, EXPIRATION_TIME);

/**
 * Image ID Generation API (POST)
 * Accepts JSON: { "url": "..." }
 * Returns JSON: { "id": "short_id" }
 */
router.post('/', async (c) => {
  try {
    const { url } = await c.req.json();
    if (!url) {
      return c.json({ error: 'URL is required' }, 400);
    }

    const now = Date.now();

    // Check if URL already has an active ID
    for (const [id, data] of urlMap.entries()) {
      if (data.url === url && now < data.expiresAt) {
        return c.json({ id });
      }
    }

    const id = nanoid(8);
    urlMap.set(id, {
      url,
      expiresAt: now + EXPIRATION_TIME,
    });

    return c.json({ id });
  } catch (error) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
});

/**
 * Image Proxy API (GET)
 * Parameters: id, height, width, quality
 */
router.get('/', async (c) => {
  const shortId = c.req.query('url') || c.req.query('id');
  const height = parseInt(c.req.query('height') || '', 10);
  const width = parseInt(c.req.query('width') || c.req.query('weight') || '', 10);
  const quality = parseInt(c.req.query('quality') || '80', 10);

  if (!shortId) {
    return c.json({ error: 'Image ID is required' }, 400);
  }

  const data = urlMap.get(shortId);

  if (!data || Date.now() > data.expiresAt) {
    if (data) urlMap.delete(shortId); // Cleanup if accessed while expired
    return c.json({ error: 'Invalid or expired image ID' }, 404);
  }

  const imageUrl = data.url;

  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const inputBuffer = Buffer.from(response.data, 'binary');

    let pipeline = sharp(inputBuffer);

    // Resizing logic
    if (!isNaN(width) || !isNaN(height)) {
      pipeline = pipeline.resize({
        width: !isNaN(width) ? width : undefined,
        height: !isNaN(height) ? height : undefined,
        fit: 'cover',
      });
    }

    // Process to JPEG for consistent output
    const outputBuffer = await pipeline.jpeg({ quality }).toBuffer();

    return c.body(new Uint8Array(outputBuffer), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    });
  } catch (error) {
    console.error('Image proxy error:', error);
    return c.json({ error: 'Failed to fetch or process image' }, 500);
  }
});

/**
 * Branding Assets API
 * Parameters: color (black/white/colored), image (logo/brand), type (svg/png), height, width, quality
 */
router.get('/branding', async (c) => {
  const color = c.req.query('color'); // black, white, or empty for colored
  const imageType = c.req.query('image') || 'logo'; // logo or brand
  const fileExtension = c.req.query('type') || 'svg'; // svg or png

  const height = parseInt(c.req.query('height') || '', 10);
  const width = parseInt(c.req.query('width') || '', 10);
  const quality = parseInt(c.req.query('quality') || '90', 10);

  // Construct the GitHub URL
  let filename = imageType;
  if (color === 'black' || color === 'white') {
    filename += `-${color}`;
  }
  filename += `.${fileExtension}`;

  const githubBase = 'https://github.com/IPTVCloud-app/assets/raw/refs/heads/main/';
  const assetUrl = `${githubBase}${filename}`;

  try {
    const response = await axios.get(assetUrl, { responseType: 'arraybuffer' });
    const inputBuffer = Buffer.from(response.data, 'binary');

    // If SVG and no resizing requested, just return the SVG content
    if (fileExtension === 'svg' && isNaN(width) && isNaN(height)) {
      return c.body(new Uint8Array(response.data), 200, { 'Content-Type': 'image/svg+xml' });
    }

    // Otherwise process with sharp (SVG to PNG/JPEG if resizing is needed or if explicit png requested)
    let pipeline = sharp(inputBuffer);

    if (!isNaN(width) || !isNaN(height)) {
      pipeline = pipeline.resize({
        width: !isNaN(width) ? width : undefined,
        height: !isNaN(height) ? height : undefined,
        fit: 'inside',
      });
    }

    // Output format handling
    let outputBuffer: Buffer;
    let contentType: string;

    if (fileExtension === 'png' || !isNaN(width) || !isNaN(height)) {
      outputBuffer = await pipeline.png({ quality }).toBuffer();
      contentType = 'image/png';
    } else {
      // Fallback for SVG if somehow logic falls through
      outputBuffer = inputBuffer;
      contentType = 'image/svg+xml';
    }

    return c.body(new Uint8Array(outputBuffer), 200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    });
  } catch (error) {
    console.error('Branding API error:', error);
    return c.json({ error: 'Failed to fetch branding asset' }, 500);
  }
});

export default router;