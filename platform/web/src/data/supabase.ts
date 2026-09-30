/**
 * The one Supabase client. Every query in the app goes through a function in
 * src/data/*.ts that uses it, so the whole backend contract is in one folder.
 *
 * Config comes from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. The anon key
 * is public by design (row-level security is the guard), so it ships in the
 * bundle.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { DataError } from './errors';

export type Db = SupabaseClient<Database>;

export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

export function readConfig(env: ImportMetaEnv = import.meta.env): SupabaseConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim() ?? '';
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
  if (!/^https?:\/\//.test(url) || anonKey === '') return null;
  return { url, anonKey };
}

let client: Db | null = null;

/** The shared client. Throws a DataError of kind 'config' when the env is missing. */
export function db(): Db {
  if (client) return client;
  const config = readConfig();
  if (!config) {
    throw new DataError(
      'Skeuos is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).',
      'config',
    );
  }
  client = createClient<Database>(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export function isConfigured(): boolean {
  return readConfig() !== null;
}
