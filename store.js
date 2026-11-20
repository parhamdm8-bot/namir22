// Data layer: loads everything from Supabase and keeps it live (Realtime).
import { sb } from "./supabase-client.js";

export const DEFAULTS = {
  brand: { name: "نمیر کافه", name_en: "NAMIR CAFE", tagline: "", logo_url: "", font: "Vazirmatn", heading_font: "Vazirmatn", base_font_size: 16,
    colors: { primary: "#70C5BB", bg: "#F5F0E5", accent: "#E9A36B", text: "#292B28", mint: "#D9EAE3", wood: "#B68B68", button: "#70C5BB", button_text: "#292B28", discount: "#C0553A" } },
  about: { title: "درباره‌ی ما", intro: "", description: "", extra: "" },
  contact: { mobile: "", landline: "", address: "", instagram_id: "", instagram_url: "", email: "", extra: "" },
  hours: { days: [] },
  animation: { intro_enabled: true, intro_logo_url: "", intro_duration_ms: 3200, intro_style: "fade-scale", intro_once_per_session: true, intro_bg: "#F5F0E5", page_animations: true, card_animation: "rise", popup_animation: "pop" },
};

export const state = { settings: structuredClone(DEFAULTS), categories: [], products: [], loaded: false, live: false };
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => listeners.forEach((f) => { try { f(what); } catch (e) { console.error(e); } });

const merge = (base, val) => {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const out = { ...base };
    for (const k of Object.keys(val)) out[k] = (base && typeof base[k] === "object" && !Array.isArray(base[k]) && val[k] && typeof val[k] === "object") ? merge(base[k], val[k]) : val[k];
    return out;
  }
  return val ?? base;
};

export async function fetchSettings() {
  const { data, error } = await sb.from("site_settings").select("key,value");
  if (error) throw error;
  const s = structuredClone(DEFAULTS);
  for (const row of data || []) s[row.key] = merge(DEFAULTS[row.key] ?? {}, row.value);
  state.settings = s;
  emit("settings");
}
export async function fetchCategories() {
  const { data, error } = await sb.from("categories").select("*").order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (error) throw error;
  state.categories = data || [];
  emit("categories");
}
export async function fetchProducts() {
  const { data, error } = await sb.from("products").select("*").order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (error) throw error;
  state.products = data || [];
  emit("products");
}
const fetchers = { site_settings: fetchSettings, categories: fetchCategories, products: fetchProducts };

export async function loadAll() {
  await Promise.all([fetchSettings(), fetchCategories(), fetchProducts()]);
  state.loaded = true;
}

// ---- Realtime with polling fallback --------------------------------
const timers = {};
function refetchSoon(table) {
  clearTimeout(timers[table]);
  timers[table] = setTimeout(() => fetchers[table]().catch((e) => console.warn("refetch failed", table, e)), 120);
}
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (!document.hidden) Object.keys(fetchers).forEach(refetchSoon); }, 20000);
}
export function subscribeRealtime() {
  try {
    const ch = sb.channel("namir-live");
    for (const table of Object.keys(fetchers)) {
      // site_settings also carries a "sync" row that the admin bumps after every change. Visitors (RLS: anon)
      // never receive UPDATE events for rows that just became hidden, so this signal refreshes everything.
      ch.on("postgres_changes", { event: "*", schema: "public", table }, () => (table === "site_settings" ? Object.keys(fetchers).forEach(refetchSoon) : refetchSoon(table)));
    }
    ch.subscribe((status) => {
      state.live = status === "SUBSCRIBED";
      if (status === "SUBSCRIBED") { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
      else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) startPolling();
    });
  } catch (e) { console.warn("realtime unavailable, polling", e); startPolling(); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) Object.keys(fetchers).forEach(refetchSoon); });
  window.addEventListener("online", () => Object.keys(fetchers).forEach(refetchSoon));
}
export const refreshAll = () => Promise.all(Object.values(fetchers).map((f) => f()));
