import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';

let supabaseInstance: SupabaseClient | null = null;

if (!supabaseUrl || !supabaseKey) {
  console.error('CRITICAL: Supabase credentials are missing from environment variables.');
} else {
  try {
    supabaseInstance = createClient(supabaseUrl, supabaseKey);
  } catch (err) {
    console.error('FAILED to initialize Supabase client:', err);
  }
}

/**
 * Export a proxy or getter to prevent early crashes if credentials are missing.
 * The rest of the app should check if supabase is available or handle the null.
 */
export const supabase = supabaseInstance as SupabaseClient;
