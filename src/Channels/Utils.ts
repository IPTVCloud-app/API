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
  try {
    const res = await axios.head(url, { 
      timeout: 2000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (status) => status >= 200 && status < 500
    });
    let status = 'offline';
    if (res.status === 403) status = 'geo-blocked';
    else if (res.status < 400) status = 'online';
    else {
      try {
        await axios.get(url, { 
          timeout: 2000, headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
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
        timeout: 2000, headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
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

export async function getOriginalId(shortId: string): Promise<string | null> {
  try {
    const { data: existing } = await supabase.from('channel_mappings').select('original_id').eq('short_id', shortId).single();
    return existing?.original_id || shortId;
  } catch (err) { return shortId; }
}
