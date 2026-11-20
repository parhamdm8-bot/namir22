import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const isConfigured =
  /^https:\/\/.+\.supabase\.(co|in)/.test(SUPABASE_URL) && !!SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith("YOUR_");

// The library is loaded only when the project is configured, and a CDN failure is
// reported to the visitor instead of leaving a blank page.
let createClient = null;
if (isConfigured) {
  try { ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4")); }
  catch (e) { console.error("supabase-js failed to load", e); }
}
export const libFailed = isConfigured && !createClient;

export const sb = createClient
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;
