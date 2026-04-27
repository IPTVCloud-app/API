import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import axios from 'axios';
import { supabase } from '../Database/DB.js';
import { Readable } from 'stream';

const router = new Hono();

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

// Persistent cache for stream mapping (channelId -> streamUrl)
let streamIndex: Map<string, string> | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60; // 1 hour

/**
 * Lightweight Streaming Indexer
 * Only keeps channelId and URL in memory to save ~80% memory.
 */
async function getStreamIndex() {
  const now = Date.now();
  if (streamIndex && (now - lastIndexLoad) < INDEX_TTL) return streamIndex;

  console.log('[Streaming] Building lightweight stream index...');
  const newIndex = new Map<string, string>();
  
  try {
    const response = await axios.get(STREAMS_URL);
    // Discard everything except ID and URL to save memory
    response.data.forEach((s: any) => {
      if (!newIndex.has(s.channel)) newIndex.set(s.channel, s.url);
    });
    
    streamIndex = newIndex;
    lastIndexLoad = now;
    console.log(`[Streaming] Index built with ${streamIndex.size} streams.`);
    return streamIndex;
  } catch (err) {
    console.error('[Streaming] Failed to build index:', err);
    return streamIndex || new Map();
  }
}

/**
 * Manual Streaming JSON Parser (Early Exit)
 * Processes a minified JSON array of objects chunk-by-chunk.
 * Stops as soon as 'limit' is reached.
 */
async function fetchChannelsSegmented(offset: number, limit: number) {
  console.log(`[Streaming] Grabbing piece: offset=${offset}, limit=${limit}`);
  const streams = await getStreamIndex();
  
  const response = await axios({
    method: 'get',
    url: CHANNELS_URL,
    responseType: 'stream'
  });

  const stream = response.data as Readable;
  const results: any[] = [];
  let currentObject = '';
  let bracketDepth = 0;
  let objectsSkipped = 0;
  let inString = false;
  let isEscaped = false;

  return new Promise<any[]>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      
      for (let i = 0; i < str.length; i++) {
        const char = str[i];

        if (inString) {
          currentObject += char;
          if (isEscaped) {
            isEscaped = false;
          } else if (char === '\\') {
            isEscaped = true;
          } else if (char === '"') {
            inString = false;
          }
          continue;
        }

        if (char === '"') {
          inString = true;
          currentObject += char;
          continue;
        }

        if (char === '{') {
          if (bracketDepth === 0) currentObject = '';
          bracketDepth++;
          currentObject += char;
        } else if (char === '}') {
          bracketDepth--;
          currentObject += char;

          if (bracketDepth === 0) {
            // Object is complete
            if (objectsSkipped < offset) {
              objectsSkipped++;
            } else {
              try {
                const ch = JSON.parse(currentObject);
                results.push({
                  ...ch,
                  stream: streams.get(ch.id) || null
                });
                
                if (results.length >= limit) {
                  stream.destroy(); // STOP the stream immediately
                  resolve(results);
                  return;
                }
              } catch (e) {
                // Continue on parse error
              }
            }
          }
        } else if (bracketDepth > 0) {
          currentObject += char;
        }
      }
    });

    stream.on('end', () => resolve(results));
    stream.on('error', (err) => reject(err));
  });
}

export async function getShortId(originalId: string): Promise<string> {
  try {
    const { data: existing } = await supabase
      .from('channel_mappings')
      .select('short_id')
      .eq('original_id', originalId)
      .single();

    if (existing) return existing.short_id;

    const shortId = nanoid(12);
    await supabase
      .from('channel_mappings')
      .insert([{ original_id: originalId, short_id: shortId }]);

    return shortId;
  } catch (err) {
    return originalId;
  }
}

export async function getOriginalId(shortId: string): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from('channel_mappings')
      .select('original_id')
      .eq('short_id', shortId)
      .single();

    return existing?.original_id || shortId;
  } catch (err) {
    return shortId;
  }
}

/**
 * List Channels (Piece-by-Piece)
 */
router.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 500);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  
  try {
    const enrichedSlice = await fetchChannelsSegmented(offset, limit);
    
    const results = await Promise.all(enrichedSlice.map(async (ch: any) => {
      const shortId = await getShortId(ch.id);
      return {
        id: shortId,
        original_id: ch.id,
        name: ch.name,
        country: ch.country,
        subdivision: ch.subdivision,
        city: ch.city,
        languages: ch.languages,
        categories: ch.categories,
        logo: ch.logo,
        stream: ch.stream,
        is_nsfw: ch.is_nsfw
      };
    }));

    return c.json(results);
  } catch (error: any) {
    console.error('[Channels] Streaming error:', error);
    return c.json({ 
      code: 500,
      message: 'Failed to stream channel pieces', 
      detail: error.message,
      url: c.req.url
    }, 500);
  }
});

/**
 * Stream Proxy
 */
router.get('/:id', async (c) => {
  const shortId = c.req.param('id');
  
  try {
    const originalId = await getOriginalId(shortId);
    const streams = await getStreamIndex();
    
    const streamUrl = streams.get(originalId || '');
    if (!streamUrl) return c.json({ error: 'Stream not found' }, 404);

    const response = await axios.get(streamUrl, {
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    let content = response.data;
    const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
    const lines = content.split('\n');
    const rewrittenLines = lines.map((line: string) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('http')) {
        return new URL(trimmed, baseUrl).href;
      }
      return line;
    });

    return c.body(rewrittenLines.join('\n'), 200, {
      'Content-Type': 'application/x-mpegURL',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) {
    return c.json({ error: 'Failed to proxy stream' }, 500);
  }
});

export default router;
