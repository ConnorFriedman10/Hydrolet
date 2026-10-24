import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Null until the keys are in app/.env, so the skeleton runs without a backend.
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null

export const isConfigured = supabase !== null
