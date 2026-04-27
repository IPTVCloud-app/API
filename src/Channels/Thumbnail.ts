import { Hono } from 'hono';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getClient, getOriginalId } from './Channel.js';

const router = new Hono();

// Use OS temp directory for caching
const TEMP_DIR = path.join(os.tmpdir(), 'iptvcloud-thumbnails');

// Ensure directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Capture Frame from M3U8
 * Captures a single frame at the 2-second mark to optimize speed.
 */
async function captureSharpestFrame(streamUrl: string, outputPath: string, shortId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(TEMP_DIR, `raw-${shortId}.jpg`);
    
    ffmpeg(streamUrl)
      .on('end', async () => {
        try {
          if (!fs.existsSync(tempFile)) {
            throw new Error('Failed to capture frame');
          }

          // Compress with Sharp
          await sharp(tempFile)
            .webp({ quality: 85 })
            .toFile(outputPath);
          
          // Cleanup
          fs.unlinkSync(tempFile);
          resolve();
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err: Error) => {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        reject(err);
      })
      .screenshots({
        timestamps: [2],
        filename: `raw-${shortId}.jpg`,
        folder: TEMP_DIR
      });
  });
}

/**
 * Thumbnail Endpoint
 */
router.get('/', async (c) => {
  const shortId = c.req.query('id');
  if (!shortId) return c.json({ error: 'Channel ID required' }, 400);

  const thumbPath = path.join(TEMP_DIR, `${shortId}.webp`);

  try {
    // 1. Check local cache
    if (fs.existsSync(thumbPath)) {
      const stats = fs.statSync(thumbPath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      if (ageHours < 1) {
        // Serve from cache
        const fileBuffer = fs.readFileSync(thumbPath);
        return c.body(fileBuffer, 200, {
          'Content-Type': 'image/webp',
          'Cache-Control': 'public, max-age=3600'
        });
      }
    }

    // 2. Generate new thumbnail
    const originalId = await getOriginalId(shortId);
    if (!originalId) return c.json({ error: 'Channel not found' }, 404);

    const client = await getClient();
    const data = client.getData();
    const chStreams = data.streams.filter((s: any) => s.channel === originalId).all();
    
    if (chStreams.length === 0) return c.json({ error: 'No streams found' }, 404);
    
    const streamUrl = chStreams[0].url;

    // Capture and save to /tmp using the sharpest frame logic
    await captureSharpestFrame(streamUrl, thumbPath, shortId);

    const fileBuffer = fs.readFileSync(thumbPath);
    return c.body(fileBuffer, 200, {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=3600'
    });

  } catch (error) {
    console.error('Thumbnail capture error:', error);
    return c.json({ error: 'Failed to capture thumbnail' }, 500);
  }
});

export default router;
