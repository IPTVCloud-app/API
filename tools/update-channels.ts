import 'dotenv/config';
import axios from 'axios';
import postgres from 'postgres';
import { checkStreamStatus, pLimit } from '../src/Channels/Stream.js';

const IPTV_ORG_BASE = 'https://iptv-org.github.io/api';
const CONCURRENCY = 50;

async function updateChannels() {
  console.log('🚀 Starting Advanced Channel Update...');

  const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('❌ Missing POSTGRES_URL in .env');
    process.exit(1);
  }

  const sql = postgres(connectionString, { ssl: 'require' });

  try {
    // 1. Sync Metadata (Categories, Languages, Countries)
    console.log('🌍 Syncing metadata...');
    const [countries, categories, languages] = await Promise.all([
      axios.get(`${IPTV_ORG_BASE}/countries.json`).then(r => r.data),
      axios.get(`${IPTV_ORG_BASE}/categories.json`).then(r => r.data),
      axios.get(`${IPTV_ORG_BASE}/languages.json`).then(r => r.data)
    ]);

    await sql`
      INSERT INTO iptv_countries ${sql(countries.map((c: any) => ({
        code: c.code, name: c.name, flag: c.flag || null, region: c.region || null
      })))} ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, flag = EXCLUDED.flag, region = EXCLUDED.region
    `;

    await sql`
      INSERT INTO iptv_categories ${sql(categories.map((c: any) => ({
        id: c.id, name: c.name
      })))} ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `;

    await sql`
      INSERT INTO iptv_languages ${sql(languages.map((l: any) => ({
        code: l.code, name: l.name
      })))} ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    `;

    // 2. Sync Channels
    console.log('📺 Syncing channel metadata...');
    const { data: allChannels } = await axios.get(`${IPTV_ORG_BASE}/channels.json`);
    const BATCH_SIZE = 1000;
    for (let i = 0; i < allChannels.length; i += BATCH_SIZE) {
      const batch = allChannels.slice(i, i + BATCH_SIZE);
      await sql`
        INSERT INTO iptv_channels ${sql(batch.map((c: any) => ({
          id: c.id, name: c.name, logo: c.logo || null, country: c.country || null,
          categories: c.categories || [], languages: c.languages || [], updated_at: new Date()
        })))} ON CONFLICT (id) DO UPDATE SET 
          name = EXCLUDED.name, logo = EXCLUDED.logo, country = EXCLUDED.country,
          categories = EXCLUDED.categories, languages = EXCLUDED.languages, updated_at = EXCLUDED.updated_at
      `;
    }

    // 3. Sync Streams
    console.log('🔗 Syncing stream URLs...');
    const { data: allStreams } = await axios.get(`${IPTV_ORG_BASE}/streams.json`);
    
    // Build a set of known channel IDs from the channels we just synced
    const channelIds = new Set(allChannels.map((c: any) => c.id));
    
    // Filter out streams without channel IDs OR referring to channels not in our database
    const validStreams = allStreams.filter((s: any) => s.channel && channelIds.has(s.channel));
    
    console.log(`   Found ${validStreams.length} valid streams (skipped ${allStreams.length - validStreams.length} orphans/invalid).`);

    for (let i = 0; i < validStreams.length; i += BATCH_SIZE) {
      const batch = validStreams.slice(i, i + BATCH_SIZE);
      await sql`
        INSERT INTO iptv_streams ${sql(batch.map((s: any) => ({
          channel_id: s.channel, url: s.url, quality: s.quality || null,
          width: s.width || null, height: s.height || null, last_checked_at: new Date()
        })))} ON CONFLICT (channel_id, url) DO UPDATE SET
          quality = EXCLUDED.quality, width = EXCLUDED.width, height = EXCLUDED.height
      `;
    }

    // 4. High-Concurrency Status Check
    console.log(`⚡ Validating streams with concurrency ${CONCURRENCY}...`);
    const streamsToNotify = await sql`
        SELECT channel_id, url FROM iptv_streams 
        WHERE status = 'unknown' OR last_checked_at < NOW() - INTERVAL '12 hours'
        LIMIT 2000
    `;

    if (streamsToNotify.length === 0) {
        console.log('✅ All streams are currently validated.');
    } else {
        const limit = pLimit(CONCURRENCY);
        let processed = 0;
        let online = 0;

        await Promise.all(streamsToNotify.map(stream => limit(async () => {
            const status = await checkStreamStatus(stream.url);
            await sql`
                UPDATE iptv_streams 
                SET status = ${status}, last_checked_at = NOW() 
                WHERE channel_id = ${stream.channel_id} AND url = ${stream.url}
            `;
            processed++;
            if (status === 'online') online++;
            if (processed % 100 === 0) {
                console.log(`   Progress: ${processed}/${streamsToNotify.length} checked (${online} online)...`);
            }
        })));
    }

    console.log('✅ Advanced Channel Update Complete.');
  } catch (error: any) {
    console.error('❌ Update failed:', error.message);
  } finally {
    await sql.end();
  }
}

updateChannels();
