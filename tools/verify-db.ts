import 'dotenv/config';
import { supabase } from '../src/Database/DB.js';
import fs from 'fs';
import path from 'path';

const sqlPath = path.join(process.cwd(), 'init.sql');
let sqlContent = '';
try {
  sqlContent = fs.readFileSync(sqlPath, 'utf8');
} catch (e) {
  console.error('❌ Could not read init.sql');
  process.exit(1);
}

const tableMatches = sqlContent.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z0-9_]+)/gi);
const REQUIRED_TABLES = Array.from(tableMatches).map(m => m[1]);

async function verifyDatabase() {
  console.log('🔍 Verifying database schema...');

  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase
      .from(table)
      .select('*')
      .limit(0);

    if (error) {
      if (error.code === '42P01' || error.message.includes('schema cache')) {
        console.error(`❌ Table "${table}" is missing.`);
      } else {
        console.error(`❓ Error checking table "${table}":`, error.message);
      }
    } else {
      console.log(`✅ Table "${table}" exists.`);
    }
  }

  // Check specific columns for users table as a sample
  const { data: userColumns, error: userError } = await supabase
    .from('users')
    .select('id, email, username, password_hash, first_name, created_at')
    .limit(0);

  if (userError) {
    console.error('❌ "users" table is missing required columns or is inaccessible.');
  } else {
    console.log('✅ "users" table columns verified.');
  }

  console.log('🏁 Verification complete.');
}

verifyDatabase().catch(err => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
