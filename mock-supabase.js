// TEST-ONLY stand-in for @supabase/supabase-js. It talks to an in-memory DB living in the
// Playwright (Node) process via window.__q, emulating RLS rules, Storage, Edge Function and Realtime.
const bc = new BroadcastChannel("mockdb");
const SESSION_KEY = "mock_session";
const getSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };
const authed = () => !!getSession();

class Q {
  constructor(table) { this.t = table; this.op = { table, action: "select", filters: [], order: [], cols: "*", authed: authed() }; }
  select(cols = "*", opts = {}) { if (this.op.action === "select") this.op.cols = cols; this.op.count = opts.count; return this; }
  insert(p) { this.op.action = "insert"; this.op.payload = p; return this; }
  update(p) { this.op.action = "update"; this.op.payload = p; return this; }
  upsert(p, o) { this.op.action = "upsert"; this.op.payload = p; this.op.onConflict = o?.onConflict; return this; }
  delete() { this.op.action = "delete"; return this; }
  eq(c, v) { this.op.filters.push([c, v]); return this; }
  gte(c, v) { return this; }
  order(c, o = {}) { this.op.order.push([c, o.ascending !== false]); return this; }
  range(a, b) { this.op.range = [a, b]; return this; }
  then(res, rej) {
    return window.__q(this.op).then((r) => {
      if (r.error) r.error = Object.assign(new Error(r.error.message), r.error);
      // Realtime+RLS emulation: anon visitors do NOT receive UPDATE events for products/categories
      // (a row that just became hidden is invisible to them). Inserts/deletes and settings do arrive.
      const silent = ["products", "categories"].includes(this.t) && this.op.action === "update";
      if (this.op.action !== "select" && !r.error && !silent) bc.postMessage({ table: this.t });
      return r;
    }).then(res, rej);
  }
}

const channels = [];
export function createClient() {
  return {
    from: (t) => new Q(t),
    channel() {
      const ch = { handlers: [], on(_e, f, cb) { ch.handlers.push([f.table, cb]); return ch; },
        subscribe(cb) { channels.push(ch); setTimeout(() => cb?.("SUBSCRIBED"), 10); return ch; } };
      return ch;
    },
    auth: {
      async getSession() { return { data: { session: getSession() } }; },
      async getUser() { const s = getSession(); return s ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "no session" } }; },
      async setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); return { data: { session: s }, error: null }; },
      async signOut() { localStorage.removeItem(SESSION_KEY); return { error: null }; },
    },
    functions: {
      async invoke(name, { body }) {
        const r = await window.__fn(name, body, navigator.userAgent);
        if (r.status !== 200) return { data: null, error: Object.assign(new Error("fn error"), { context: { status: r.status } }) };
        return { data: r.body, error: null };
      },
    },
    storage: {
      from: (bucket) => ({
        async upload(path, blob, opts) {
          if (!authed()) return { error: { message: "new row violates row-level security policy", statusCode: 403 } };
          const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ""; buf.forEach((b) => (bin += String.fromCharCode(b)));
          await window.__upload(bucket, path, btoa(bin), opts.contentType); return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://mock.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
        async remove(paths) { return { data: paths, error: null }; },
      }),
    },
  };
}
bc.onmessage = (e) => channels.forEach((ch) => ch.handlers.forEach(([t, cb]) => { if (t === e.data.table) cb({}); }));
