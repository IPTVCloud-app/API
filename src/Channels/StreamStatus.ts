import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { checkStreamStatus } from './Utils.js';

const app = new Hono();

/**
 * Batch Channel Status Check
 * Designed to be called by a Vercel Cron Job
 */
app.get('/check', async (c) => {
  const BATCH_SIZE = 100;
  const CONCURRENCY = 10;

  console.log(`[Cron] Starting channel status check (Batch: ${BATCH_SIZE})...`);

  try {
    // 1. Fetch oldest checked streams
    const { data: streams, error: fetchError } = await supabase
      .from('iptv_streams')
      .select('id, url, channel_id')
      .order('last_checked_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error('[Cron] Database fetch error:', fetchError.message);
      throw fetchError;
    }
    
    if (!streams || streams.length === 0) {
      return c.json({ message: 'No streams to check' });
    }

    let processed = 0;
    let online = 0;
    let offline = 0;

    // 2. Process in smaller concurrent batches
    for (let i = 0; i < streams.length; i += CONCURRENCY) {
      const batch = streams.slice(i, i + CONCURRENCY);
      
      await Promise.all(batch.map(async (stream) => {
        try {
          const status = await checkStreamStatus(stream.url);
          
          const { error: updateError } = await supabase
            .from('iptv_streams')
            .update({ 
              status, 
              last_checked_at: new Date().toISOString() 
            })
            .eq('id', stream.id);

          if (updateError) {
            console.error(`[Cron] Failed to update stream ${stream.id}:`, updateError.message);
          } else {
            processed++;
            if (status === 'online') online++;
            else offline++;
          }
        } catch (streamErr: any) {
          console.error(`[Cron] Error checking stream ${stream.id}:`, streamErr.message);
        }
      }));
    }

    console.log(`[Cron] Completed: ${processed} checked (${online} online, ${offline} offline/other)`);
    return c.json({ 
      status: 'success', 
      processed, 
      online, 
      offline 
    });

  } catch (error: any) {
    console.error('[Cron] Fatal error during status check:', error.message);
    return c.json({ error: error.message }, 500);
  }
});

export default app;
