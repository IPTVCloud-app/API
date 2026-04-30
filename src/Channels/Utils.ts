import { nanoid } from 'nanoid';
import axios from 'axios';
import { supabase } from '../Database/DB.js';

// Status Cache
const statusCache = new Map<string, { status: string, time: number }>();
const STATUS_TTL = 1000 * 60 * 5; // 5 minutes

/**
 * Check if a stream is online
 */
export async function checkStreamStatus(url: string | null): Promise<string> {
  if (!url) return 'offline';
  const cached = statusCache.get(url);
  if (cached && (Date.now() - cached.time) < STATUS_TTL) return cached.status;
  
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };

  try {
    const res = await axios.head(url, { 
      timeout: 5000,
      headers,
      validateStatus: (status) => status >= 200 && status < 500
    });
    let status = 'offline';
    if (res.status === 403) status = 'geo-blocked';
    else if (res.status < 400) status = 'online';
    else {
      try {
        await axios.get(url, { 
          timeout: 5000, headers: { ...headers, 'Range': 'bytes=0-0' },
          validateStatus: (status) => status >= 200 && status < 400
        });
        status = 'online';
      } catch (e) {}
    }
    statusCache.set(url, { status, time: Date.now() });
    return status;
  } catch (err: any) {
    if (err.response?.status === 403) {
      statusCache.set(url, { status: 'geo-blocked', time: Date.now() });
      return 'geo-blocked';
    }
    try {
      await axios.get(url, { 
        timeout: 5000, headers: { ...headers, 'Range': 'bytes=0-0' },
        validateStatus: (status) => status >= 200 && status < 400
      });
      statusCache.set(url, { status: 'online', time: Date.now() });
      return 'online';
    } catch (e: any) {
      const finalStatus = e.response?.status === 403 ? 'geo-blocked' : 'offline';
      statusCache.set(url, { status: finalStatus, time: Date.now() });
      return finalStatus;
    }
  }
}

export async function getShortId(originalId: string): Promise<string> {
  try {
    const { data: existing } = await supabase.from('channel_mappings').select('short_id').eq('original_id', originalId).single();
    if (existing) return existing.short_id;
    const shortId = nanoid(12);
    await supabase.from('channel_mappings').insert([{ original_id: originalId, short_id: shortId }]);
    return shortId;
  } catch (err) { return originalId; }
}

export async function getShortIds(originalIds: string[]): Promise<Record<string, string>> {
  if (originalIds.length === 0) return {};
  try {
    const { data: mappings } = await supabase
      .from('channel_mappings')
      .select('original_id, short_id')
      .in('original_id', originalIds);

    const map: Record<string, string> = {};
    const existingIds = new Set();

    if (mappings) {
      for (const m of mappings) {
        map[m.original_id] = m.short_id;
        existingIds.add(m.original_id);
      }
    }

    const missingIds = originalIds.filter(id => !existingIds.has(id));
    if (missingIds.length > 0) {
      const newMappings = missingIds.map(id => ({
        original_id: id,
        short_id: nanoid(12)
      }));
      await supabase.from('channel_mappings').insert(newMappings);
      for (const nm of newMappings) {
        map[nm.original_id] = nm.short_id;
      }
    }

    return map;
  } catch (err) {
    return originalIds.reduce((acc, id) => ({ ...acc, [id]: id }), {});
  }
}

export async function getOriginalId(shortId: string): Promise<string | null> {
  try {
    const { data: existing } = await supabase.from('channel_mappings').select('original_id').eq('short_id', shortId).single();
    return existing?.original_id || shortId;
  } catch (err) { return shortId; }
}
