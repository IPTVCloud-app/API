import 'dotenv/config';
import axios from 'axios';
import postgres from 'postgres';

const IPTV_ORG_BASE = 'https://iptv-org.github.io/api';

async function syncIPTV() {
  console.log('🚀 Starting IPTV-org synchronization...');

  const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('❌ Missing POSTGRES_URL in .env');
    process.exit(1);
  }

  const sql = postgres(connectionString, { ssl: 'require' });

  try {
    // 1. Sync Countries
    console.log('🌍 Syncing countries...');
    const { data: countries } = await axios.get(`${IPTV_ORG_BASE}/countries.json`);
    await sql`
      INSERT INTO iptv_countries ${sql(countries.map((c: any) => ({
        code: c.code,
        name: c.name,
        flag: c.flag || null,
        region: c.region || null
      })))}
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        flag = EXCLUDED.flag,
        region = EXCLUDED.region
    `;

    // 2. Sync Categories
    console.log('📂 Syncing categories...');
    const { data: categories } = await axios.get(`${IPTV_ORG_BASE}/categories.json`);
    await sql`
      INSERT INTO iptv_categories ${sql(categories.map((c: any) => ({
        id: c.id,
        name: c.name
      })))}
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name
    `;

    // 3. Sync Languages
    console.log('🗣️ Syncing languages...');
    const { data: languages } = await axios.get(`${IPTV_ORG_BASE}/languages.json`);
    await sql`
      INSERT INTO iptv_languages ${sql(languages.map((l: any) => ({
        code: l.code,
        name: l.name
      })))}
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name
    `;

    // 4. Sync Channels (In batches to avoid memory/SQL issues)
    console.log('📺 Syncing channels...');
    const { data: channels } = await axios.get(`${IPTV_ORG_BASE}/channels.json`);
    const BATCH_SIZE = 1000;
    for (let i = 0; i < channels.length; i += BATCH_SIZE) {
      const batch = channels.slice(i, i + BATCH_SIZE);
      await sql`
        INSERT INTO iptv_channels ${sql(batch.map((c: any) => ({
          id: c.id,
          name: c.name,
          logo: c.logo || null,
          country: c.country || null,
          subdivision: c.subdivision || null,
          city: c.city || null,
          broadcast_area: c.broadcast_area || [],
          categories: c.categories || [],
          languages: c.languages || [],
          is_nsfw: c.is_nsfw || false,
          website: c.website || null,
          network: c.network || null,
          updated_at: new Date()
        })))}
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          logo = EXCLUDED.logo,
          country = EXCLUDED.country,
          subdivision = EXCLUDED.subdivision,
          city = EXCLUDED.city,
          broadcast_area = EXCLUDED.broadcast_area,
          categories = EXCLUDED.categories,
          languages = EXCLUDED.languages,
          is_nsfw = EXCLUDED.is_nsfw,
          website = EXCLUDED.website,
          network = EXCLUDED.network,
          updated_at = EXCLUDED.updated_at
      `;
      console.log(`   Processed ${Math.min(i + BATCH_SIZE, channels.length)}/${channels.length} channels...`);
    }

    // 5. Sync Streams
    console.log('🔗 Syncing streams...');
    const { data: streamsData } = await axios.get('https://iptvcloud-app.github.io/EPG/streams.json');
    const streams = Array.isArray(streamsData) ? streamsData : (streamsData.streams || []);
    
    // Build a set of known channel IDs from the channels we just synced
    const channelIds = new Set(channels.map((c: any) => c.id));
    
    // Filter out streams without channel IDs OR referring to channels not in our database
    const validStreams = streams.filter((s: any) => s.channel && channelIds.has(s.channel));
    
    console.log(`   Found ${validStreams.length} valid streams (skipped ${streams.length - validStreams.length} orphans/invalid).`);

    for (let i = 0; i < validStreams.length; i += BATCH_SIZE) {
      const batch = validStreams.slice(i, i + BATCH_SIZE);
      await sql`
        INSERT INTO iptv_streams ${sql(batch.map((s: any) => ({
          channel_id: s.channel,
          url: s.url,
          timeshift: s.timeshift || null,
          http_referrer: s.http_referrer || null,
          user_agent: s.user_agent || null,
          quality: s.quality || null,
          width: s.width || null,
          height: s.height || null,
          status: s.status || 'unknown',
          last_checked_at: new Date()
        })))}
        ON CONFLICT (channel_id, url) DO UPDATE SET
          timeshift = EXCLUDED.timeshift,
          http_referrer = EXCLUDED.http_referrer,
          user_agent = EXCLUDED.user_agent,
          quality = EXCLUDED.quality,
          width = EXCLUDED.width,
          height = EXCLUDED.height,
          status = EXCLUDED.status,
          last_checked_at = EXCLUDED.last_checked_at
      `;
      console.log(`   Processed ${Math.min(i + BATCH_SIZE, validStreams.length)}/${validStreams.length} streams...`);
    }

    console.log('✅ IPTV-org synchronization complete.');
  } catch (error: any) {
    console.error('❌ Sync failed:', error.message);
  } finally {
    await sql.end();
  }
}

syncIPTV();
