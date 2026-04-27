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
 * Capture Sharpest Frame from M3U8
 * Captures frames at 2s, 6s, and 12s. Picks the one with the largest file size (most detail/entropy).
 */
async function captureSharpestFrame(streamUrl: string, outputPath: string, shortId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tempPrefix = `raw-${shortId}`;
    
    // We will extract 3 frames at specific timestamps
    ffmpeg(streamUrl)
      .on('end', async () => {
        try {
          // Find the largest file among the captured frames
          const frames = [1, 2, 3].map(i => path.join(TEMP_DIR, `${tempPrefix}_${i}.jpg`));
          
          let largestFile = '';
          let maxSize = -1;

          for (const frame of frames) {
            if (fs.existsSync(frame)) {
              const stats = fs.statSync(frame);
              if (stats.size > maxSize) {
                maxSize = stats.size;
                largestFile = frame;
              }
            }
          }

          if (!largestFile || maxSize === -1) {
            throw new Error('Failed to capture any valid frames');
          }

          // Compress the winning frame with Sharp
          await sharp(largestFile)
            .webp({ quality: 85 }) // High quality WebP
            .toFile(outputPath);
          
          // Cleanup all raw frames
          for (const frame of frames) {
            if (fs.existsSync(frame)) {
              fs.unlinkSync(frame);
            }
          }

          resolve();
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err: Error) => {
        // Also attempt to cleanup on error
        [1, 2, 3].forEach(i => {
           const f = path.join(TEMP_DIR, `${tempPrefix}_${i}.jpg`);
           if (fs.existsSync(f)) fs.unlinkSync(f);
        });
        reject(err);
      })
      .screenshots({
        timestamps: [2, 6, 12],
        filename: `${tempPrefix}_%i.jpg`,
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
