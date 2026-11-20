// Supabase Edge Function: admin-login
// Server-side validation of the single predefined Manager account.
// Credentials live ONLY in Edge Function secrets — never in frontend code.
//
// Required secrets (supabase secrets set ...):
//   ADMIN_USERNAME   e.g. Manager
//   ADMIN_PASSWORD   e.g. webmanagecafe
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// Flow: client sends {username,password,device} → function compares with secrets
// (constant-time) → logs attempt (success/failure) into login_history using the
// service role → on success signs in the single hidden Auth user and returns
// its session → the browser uses that session; RLS only allows that user to write.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function parseUA(ua: string) {
  const u = ua || "";
  let browser = "نامشخص";
  if (/Edg\//.test(u)) browser = "Edge";
  else if (/OPR\/|Opera/.test(u)) browser = "Opera";
  else if (/SamsungBrowser/.test(u)) browser = "Samsung Internet";
  else if (/Firefox\//.test(u)) browser = "Firefox";
  else if (/Chrome\//.test(u)) browser = "Chrome";
  else if (/Safari\//.test(u)) browser = "Safari";
  let os = "نامشخص";
  if (/Windows NT 10/.test(u)) os = "Windows 10/11";
  else if (/Windows/.test(u)) os = "Windows";
  else if (/Android ([\d.]+)/.test(u)) os = "Android " + (u.match(/Android ([\d.]+)/)?.[1] ?? "");
  else if (/(iPhone|iPad).*OS ([\d_]+)/.test(u)) os = "iOS " + (u.match(/OS ([\d_]+)/)?.[1] ?? "").replace(/_/g, ".");
  else if (/Mac OS X/.test(u)) os = "macOS";
  else if (/Linux/.test(u)) os = "Linux";
  let device = "دسکتاپ";
  if (/iPad|Tablet/.test(u)) device = "تبلت";
  else if (/Mobi|iPhone|Android/.test(u)) device = "موبایل";
  return { browser, os, device };
}

// Simple brute-force protection: >=8 failures in the last 10 minutes → locked.
async function tooManyFailures(admin: ReturnType<typeof createClient>, ip: string) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("login_history")
    .select("id", { count: "exact", head: true })
    .eq("success", false)
    .eq("ip", ip)
    .gte("created_at", since);
  return (count ?? 0) >= 8;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ADMIN_USERNAME = Deno.env.get("ADMIN_USERNAME") ?? "";
  const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return json({ error: "server_not_configured" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const username = String(body.username ?? "").slice(0, 100);
  const password = String(body.password ?? "").slice(0, 200);
  const clientDevice = body.device && typeof body.device === "object" ? body.device : {};

  const ua = req.headers.get("user-agent") ?? "";
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const parsed = parseUA(ua);

  const admin = createClient(url, service, { auth: { persistSession: false } });

  const log = (success: boolean, reason: string) =>
    admin.from("login_history").insert({
      username: username || null,
      success,
      ip,
      user_agent: ua.slice(0, 500),
      browser: parsed.browser,
      os: parsed.os,
      device_type: parsed.device,
      details: {
        reason,
        screen: clientDevice.screen ?? null,
        language: clientDevice.language ?? null,
        timezone: clientDevice.timezone ?? null,
        platform: clientDevice.platform ?? null,
        touch: clientDevice.touch ?? null,
        memory_gb: clientDevice.memory ?? null,
        cores: clientDevice.cores ?? null,
      },
    });

  if (await tooManyFailures(admin, ip)) {
    await log(false, "rate_limited");
    return json({ error: "too_many_attempts" }, 429);
  }

  const okUser = safeEqual(username, ADMIN_USERNAME);
  const okPass = safeEqual(password, ADMIN_PASSWORD);
  if (!(okUser && okPass)) {
    await log(false, "invalid_credentials");
    return json({ error: "invalid_credentials" }, 401);
  }

  // The single hidden Auth user. Its (long, random-looking) password is derived
  // from the service key + admin password, so it is never typed by anyone.
  const email = "manager@namir-cafe.internal";
  const authPassword = await derive(service + ":" + ADMIN_PASSWORD);

  // Ensure the user exists (idempotent) and its password matches.
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 50 });
  const existing = list?.users?.find((u) => u.email === email);
  if (!existing) {
    const { error } = await admin.auth.admin.createUser({ email, password: authPassword, email_confirm: true });
    if (error) { await log(false, "provision_failed"); return json({ error: "server_error" }, 500); }
  } else {
    await admin.auth.admin.updateUserById(existing.id, { password: authPassword });
  }

  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: authPassword });
  if (error || !data.session) { await log(false, "session_failed"); return json({ error: "server_error" }, 500); }

  await log(true, "ok");
  return json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});

async function derive(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
