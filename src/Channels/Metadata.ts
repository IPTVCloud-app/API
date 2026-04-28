import { Hono } from 'hono';
import axios from 'axios';

const router = new Hono();

// Metadata Sources
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const LANGUAGES_URL = 'https://iptv-org.github.io/api/languages.json';
const REGIONS_URL = 'https://iptv-org.github.io/api/regions.json';
const TIMEZONES_URL = 'https://iptv-org.github.io/api/timezones.json';
const CATEGORIES_URL = 'https://iptv-org.github.io/api/categories.json';
const CITIES_URL = 'https://iptv-org.github.io/api/cities.json';
const SUBDIVISIONS_URL = 'https://iptv-org.github.io/api/subdivisions.json';

// Persistent caches
let metadataMaps: {
  countries: Map<string, any>;
  languages: Map<string, string>;
  regions: Map<string, string>;
  timezones: Map<string, string[]>;
  categories: any[];
  cities: any[];
  subdivisions: any[];
} | null = null;
let lastIndexLoad = 0;
const INDEX_TTL = 1000 * 60 * 60;  // 1 hour cache

/**
 * Build Metadata Lookups (Optimized with caching and concurrent fetching)
 */
export async function getMetadataMaps() {
  const now = Date.now();
  if (metadataMaps && (now - lastIndexLoad) < INDEX_TTL) return metadataMaps;
  
  try {
    console.log('[Metadata] Refreshing indexes...');
    const [cnt, lng, reg, tz, cat, city, sub] = await Promise.all([
      axios.get(COUNTRIES_URL, { timeout: 10000 }).then(r => r.data),
      axios.get(LANGUAGES_URL, { timeout: 10000 }).then(r => r.data),
      axios.get(REGIONS_URL, { timeout: 10000 }).then(r => r.data),
      axios.get(TIMEZONES_URL, { timeout: 10000 }).then(r => r.data),
      axios.get(CATEGORIES_URL, { timeout: 10000 }).then(r => r.data),
      axios.get(CITIES_URL, { timeout: 10000 }).then(r => r.data),
      axios.get(SUBDIVISIONS_URL, { timeout: 10000 }).then(r => r.data)
    ]);

    const countryToTz = new Map<string, string[]>();
    tz.forEach((t: any) => {
      t.countries?.forEach((code: string) => {
        const list = countryToTz.get(code) || [];
        if (t.code) list.push(t.code);
        countryToTz.set(code, list);
      });
    });

    metadataMaps = {
      countries: new Map(cnt.map((c: any) => [c.code, c])),
      languages: new Map(lng.map((l: any) => [l.code, l.name])),
      regions: new Map(reg.map((r: any) => [r.code, r.name])),
      timezones: countryToTz,
      categories: cat,
      cities: city,
      subdivisions: sub
    };
    
    lastIndexLoad = now;
    return metadataMaps;
  } catch (err) {
    console.error('[Metadata] Failed to load metadata:', err);
    return metadataMaps || { countries: new Map(), languages: new Map(), regions: new Map(), timezones: new Map(), categories: [], cities: [], subdivisions: [] };
  }
}

/**
 * Metadata Endpoints
 */
router.get('/categories', async (c) => {
  const meta = await getMetadataMaps();
  return c.json(meta.categories);
});

router.get('/languages', async (c) => {
  const meta = await getMetadataMaps();
  const list = Array.from(meta.languages.entries()).map(([code, name]) => ({ code, name }));
  return c.json(list);
});

router.get('/cities', async (c) => {
  const meta = await getMetadataMaps();
  return c.json(meta.cities);
});

router.get('/subdivisions', async (c) => {
  const meta = await getMetadataMaps();
  return c.json(meta.subdivisions);
});

router.get('/countries', async (c) => {
  const meta = await getMetadataMaps();
  const list = Array.from(meta.countries.values());
  return c.json(list);
});

router.get('/regions', async (c) => {
  const meta = await getMetadataMaps();
  const list = Array.from(meta.regions.entries()).map(([code, name]) => ({ code, name }));
  return c.json(list);
});

export default router;
