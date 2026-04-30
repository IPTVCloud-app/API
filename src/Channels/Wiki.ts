import { Hono } from 'hono';

const app = new Hono();

app.get('/', async (c) => {
  const query = c.req.query('q');
  if (!query) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  try {
    const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
    
    if (wikiRes.ok) {
      const wikiData = await wikiRes.json();
      if (wikiData.extract) {
        return c.json({ extract: wikiData.extract });
      }
    }
    
    return c.json({ extract: null }, 404);
  } catch (error) {
    console.error("Wiki fetch error:", error);
    return c.json({ error: 'Failed to fetch Wikipedia summary' }, 500);
  }
});

export default app;
