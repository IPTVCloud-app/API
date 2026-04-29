import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';

const router = new Hono();

/**
 * Metadata Endpoints - Now fetching from Supabase for maximum speed
 */

router.get('/categories', async (c) => {
  try {
    const { data, error } = await supabase
      .from('iptv_categories')
      .select('*')
      .order('name', { ascending: true });
    
    if (error) throw error;
    return c.json(data);
  } catch (err) {
    console.error('[Metadata] Categories fetch error:', err);
    return c.json({ error: 'Failed to fetch categories' }, 500);
  }
});

router.get('/languages', async (c) => {
  try {
    const { data, error } = await supabase
      .from('iptv_languages')
      .select('code, name')
      .order('name', { ascending: true });
    
    if (error) throw error;
    return c.json(data);
  } catch (err) {
    console.error('[Metadata] Languages fetch error:', err);
    return c.json({ error: 'Failed to fetch languages' }, 500);
  }
});

router.get('/countries', async (c) => {
  try {
    const { data, error } = await supabase
      .from('iptv_countries')
      .select('*')
      .order('name', { ascending: true });
    
    if (error) throw error;
    return c.json(data);
  } catch (err) {
    console.error('[Metadata] Countries fetch error:', err);
    return c.json({ error: 'Failed to fetch countries' }, 500);
  }
});

router.get('/regions', async (c) => {
  try {
    const { data, error } = await supabase
      .from('iptv_countries')
      .select('region')
      .not('region', 'is', null);
    
    if (error) throw error;
    
    // Deduplicate regions
    const regions = Array.from(new Set(data.map(i => i.region))).sort().map(r => ({ code: r?.toLowerCase(), name: r }));
    return c.json(regions);
  } catch (err) {
    console.error('[Metadata] Regions fetch error:', err);
    return c.json({ error: 'Failed to fetch regions' }, 500);
  }
});

// Helper for other modules (deprecated axios version)
export async function getMetadataMaps() {
  const { data: cnt } = await supabase.from('iptv_countries').select('*');
  const { data: lng } = await supabase.from('iptv_languages').select('*');
  
  return {
    countries: new Map((cnt || []).map((c: any) => [c.code, c])),
    languages: new Map((lng || []).map((l: any) => [l.code, l.name])),
    // Add other fields if needed, but the API should primarily use SQL joins now
  };
}

export default router;
