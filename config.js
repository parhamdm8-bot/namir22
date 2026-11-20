// ---------------------------------------------------------------
// Public Supabase settings. These two values are SAFE to be public:
// the anon key can only do what Row Level Security allows
// (read-only for visitors). NEVER put the service_role key here.
// Replace them with the values from:
//   Supabase Dashboard → Project Settings → API
// ---------------------------------------------------------------
export const SUPABASE_URL = "YOUR_SUPABASE_URL";
export const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
export const STORAGE_BUCKET = "namir-assets";
export const ADMIN_FUNCTION = "admin-login";
