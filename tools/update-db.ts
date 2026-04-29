import 'dotenv/config';
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';

async function updateDatabase() {
  console.log('🚀 Starting database schema updates...');

  const sqlPath = path.join(process.cwd(), 'init.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('❌ init.sql not found at', sqlPath);
    process.exit(1);
  }

  const sqlContent = fs.readFileSync(sqlPath, 'utf8');

  console.log(`🛠️ Applying full schema from init.sql...`);

  const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

  if (!connectionString) {
    console.warn(`⚠️  Cannot automatically execute SQL: Missing POSTGRES_URL_NON_POOLING or POSTGRES_URL in .env`);
    console.log(`👉 Please run the following SQL manually in your Supabase SQL Editor:\n\n${sqlContent}\n`);
    process.exit(1);
  }

  try {
    const sql = postgres(connectionString, { 
      ssl: 'require',
      onnotice: (notice) => {
        // Suppress "already exists, skipping" notices to keep output clean
        if (notice.code === '42P07' || notice.message?.includes('already exists, skipping')) {
          return;
        }
        console.log(`📝 DB Notice: ${notice.message}`);
      }
    });
    await sql.unsafe(sqlContent);
    console.log(`✅ Database schema applied successfully.`);
    await sql.end();
  } catch (error: any) {
    console.error(`❌ Error applying schema:`, error.message);
  }

  console.log('🏁 Database update process finished.');
}

updateDatabase().catch(err => {
  console.error('Fatal error during update:', err);
  process.exit(1);
});
