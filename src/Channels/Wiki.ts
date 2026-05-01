import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { getOriginalId } from './Utils.js';

const app = new Hono();

app.get('/', async (c) => {
  const id = c.req.query('id');
  if (!id) {
    return c.json({ error: 'Query parameter "id" is required' }, 400);
  }

  try {
    const originalId = await getOriginalId(id);
    
    // Look up the actual channel name
    const { data: channel, error: dbError } = await supabase
      .from('iptv_channels')
      .select('name')
      .eq('id', originalId)
      .single();

    if (dbError || !channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const channelName = channel.name;

    // 1. Try Wikipedia first
    try {
      const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(channelName)}`);
      
      if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        // Check if extract exists and is not a disambiguation page indicator
        if (wikiData.extract && !wikiData.extract.includes("may refer to")) {
          return c.json({ extract: wikiData.extract });
        }
      }
    } catch (wikiErr) {
      console.error("[Wiki] Wikipedia fetch failed, trying fallback:", wikiErr);
    }

    // 2. Fallback to Pollinations AI Text Generation
    try {
      const prompt = `Write a concise 2-3 sentence encyclopedia summary about the television channel named "${channelName}". Do not include conversational filler, greetings, or pleasantries, just the facts.`;
      const pollinationsUrl = `https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=searchgpt`;
      
      const aiRes = await fetch(pollinationsUrl);
      
      if (aiRes.ok) {
        const aiText = await aiRes.text();
        if (aiText && aiText.trim().length > 0) {
          return c.json({ extract: aiText.trim() });
        }
      }
    } catch (aiErr) {
      console.error("[Wiki] Pollinations AI fallback failed:", aiErr);
    }
    
    return c.json({ extract: null }, 404);
  } catch (error) {
    console.error("[Wiki] Fatal fetch error:", error);
    return c.json({ error: 'Failed to fetch channel summary' }, 500);
  }
});

export default app;
