import { Hono } from 'hono';
import sdk from '@iptv-org/sdk';
import { nanoid } from 'nanoid';
import axios from 'axios';
import { supabase } from '../Database/DB.js';

const router = new Hono();

// Cache for SDK data
let sdkClient: any = null;
let lastLoad = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

export async function getClient() {
  const now = Date.now();
  if (!sdkClient || (now - lastLoad) > CACHE_TTL) {
    console.log('[SDK] Initializing iptv-org/sdk client...');
    try {
      sdkClient = new sdk.Client();
      await sdkClient.load();
      lastLoad = now;
      console.log('[SDK] Client loaded successfully.');
    } catch (err) {
      console.error('[SDK] Failed to load client:', err);
      throw err;
    }
  }
  return sdkClient;
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
    console.warn(`[DB] Error mapping ${originalId}, using original ID as fallback:`, err);
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

    return existing?.original_id || shortId; // Fallback to shortId if mapping doesn't exist
  } catch (err) {
    return shortId;
  }
}

/**
 * List Channels
 */
router.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  console.log(`[Channels] Fetching up to ${limit} channels...`);
  
  try {
    const client = await getClient();
    const data = client.getData();
    
    if (!data || !data.channels) {
      console.error('[Channels] No data returned from SDK.');
      return c.json({ error: 'No channel data available' }, 500);
    }

    const blockedIds = data.blocklist.all().map((b: any) => b.channel);
    const allChannels = data.channels.all();
    console.log(`[Channels] Total channels found: ${allChannels.length}`);
    
    const filtered = allChannels.filter((ch: any) => !blockedIds.includes(ch.id));
    console.log(`[Channels] Filtered channels (excluding blocked): ${filtered.length}`);
    
    const slice = filtered.slice(0, limit);
    
    const results = await Promise.all(slice.map(async (ch: any) => {
      try {
        const shortId = await getShortId(ch.id);
        const chStreams = data.streams.filter((s: any) => s.channel === ch.id).all();
        const qualities = chStreams.map((s: any) => s.quality).filter(Boolean);
        const quality = qualities.length > 0 ? qualities[0] : 'SD';

        return {
          id: shortId,
          name: ch.name,
          logo: ch.logo,
          category: ch.categories?.[0] || 'General',
          country: ch.countries?.[0] || 'Unknown',
          quality: quality,
          language: ch.languages?.[0] || 'English'
        };
      } catch (err) {
        console.warn(`[Channels] Error mapping channel ${ch.id}:`, err);
        return null;
      }
    }));

    const finalResults = results.filter(Boolean);
    console.log(`[Channels] Returning ${finalResults.length} results.`);

    return c.json(finalResults);
  } catch (error) {
    console.error('[Channels] Route error:', error);
    return c.json({ 
      code: 500,
      message: 'Failed to fetch channels', 
      detail: (error as Error).message,
      url: c.req.url
    }, 500);
  }
});

/**
 * Stream Proxy
 */
router.get('/:id', async (c) => {
  const shortId = c.req.param('id');
  const resolution = c.req.query('res');
  
  try {
    const originalId = await getOriginalId(shortId);
    if (!originalId) return c.json({ error: 'Channel not found' }, 404);

    const client = await getClient();
    const data = client.getData();
    const chStreams = data.streams.filter((s: any) => s.channel === originalId).all();
    
    if (chStreams.length === 0) return c.json({ error: 'No streams found' }, 404);

    let selectedStream = chStreams[0];
    if (resolution) {
      const match = chStreams.find((s: any) => s.quality === resolution);
      if (match) selectedStream = match;
    }

    const streamUrl = selectedStream.url;
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
    console.error('Proxy error:', error);
    return c.json({ error: 'Failed to proxy stream' }, 500);
  }
});

export default router;
