// End-to-end UI tests against a MOCK Supabase (in-memory). Run: node tests/run.mjs
// Real Supabase is not reachable from this sandbox, so backend-specific parts
// (RLS, Edge Function, Storage, Realtime) are emulated; see README for what that covers.
import { createRequire } from "module";
import http from "http"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, "../public");
const SHOTS = path.join(__dirname, "shots"); fs.mkdirSync(SHOTS, { recursive: true });

// ---------- static server ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); return res.end("nf"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const BASE = `http://localhost:${server.address().port}`;

// ---------- in-memory DB emulating schema + RLS ----------
const id = () => Math.random().toString(36).slice(2, 10);
const db = {
  site_settings: [
    ["brand", { name: "نمیر کافه", name_en: "NAMIR CAFE", tagline: "روحِ قدیمی، تجربه‌ی امروزی", logo_url: "", font: "Vazirmatn", base_font_size: 16, colors: { primary: "#70C5BB", bg: "#F5F0E5", accent: "#E9A36B", text: "#292B28", mint: "#D9EAE3", wood: "#B68B68", button: "#70C5BB", button_text: "#292B28", discount: "#C0553A" } }],
    ["about", { title: "درباره‌ی ما", intro: "معرفی نمونه", description: "توضیح نمونه", extra: "" }],
    ["contact", { mobile: "09123456789", landline: "02112345678", address: "تهران، خیابان نمونه", instagram_id: "@namir.cafe", instagram_url: "https://instagram.com/namir.cafe", email: "", extra: "" }],
    ["hours", { days: ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"].map((day) => ({ day, open: "05:30", close: "23:00", closed: false })) }],
    ["animation", { intro_enabled: true, intro_logo_url: "", intro_duration_ms: 1200, intro_style: "fade-scale", intro_once_per_session: true, intro_bg: "#F5F0E5", page_animations: true, card_animation: "rise", popup_animation: "pop" }],
  ].map(([key, value]) => ({ key, value })),
  categories: [], products: [], login_history: [],
};
const c1 = { id: "c1", name: "قهوه‌های گرم", sort_order: 1, visible: true, image_url: null }, c2 = { id: "c2", name: "نوشیدنی‌های سرد", sort_order: 2, visible: true, image_url: null };
db.categories.push(c1, c2);
const mk = (n, cat, price, o = {}) => ({ id: id(), category_id: cat, name: n, description: "توضیح " + n, ingredients: "اسپرسو، شیر", image_url: null, price, discount_active: false, discount_price: null, discount_reason: "", sort_order: db.products.length + 1, visible: true, created_at: new Date().toISOString(), ...o });
db.products.push(mk("اسپرسو", "c1", 75000), mk("لاته", "c1", 120000, { discount_active: true, discount_price: 99000, discount_reason: "تخفیف صبحانه" }), mk("آیس لاته", "c2", 135000), mk("کاپوچینو مخفی", "c1", 1, { visible: false }));
const storage = new Map(); const fails = new Map();

function q(op) {
  const { table, action, filters, order, range, payload, authed } = op; const rows = db[table];
  if (!rows) return { error: { message: "no table" } };
  const write = action !== "select";
  if (table === "login_history" && (write || !authed)) return { error: { code: "42501", message: "rls" } };
  if (write && !authed) return { error: { code: "42501", message: "new row violates row-level security policy" } };
  const match = (r) => filters.every(([c, v]) => r[c] === v);
  if (action === "select") {
    let out = rows.filter(match);
    if (!authed && (table === "products" || table === "categories")) out = out.filter((r) => r.visible);
    for (const [c, asc] of [...order].reverse()) out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    const count = out.length; if (range) out = out.slice(range[0], range[1] + 1);
    return { data: structuredClone(out), count, error: null };
  }
  if (action === "insert") { const r = { id: id(), visible: true, created_at: new Date().toISOString(), sort_order: 0, ...payload }; rows.push(r); return { data: [r], error: null }; }
  if (action === "update") { rows.filter(match).forEach((r) => Object.assign(r, payload)); return { error: null }; }
  if (action === "delete") { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) rows.splice(i, 1); return { error: null }; }
  if (action === "upsert") { const k = op.onConflict || "id"; const ex = rows.find((r) => r[k] === payload[k]); if (ex) Object.assign(ex, payload); else rows.push(payload); return { error: null }; }
}
function fn(name, body, ua) {
  const ip = "1.2.3.4"; const log = (success) => db.login_history.unshift({ id: db.login_history.length + 1, created_at: new Date().toISOString(), username: body.username, success, ip, user_agent: ua, browser: /Chrome/.test(ua) ? "Chrome" : "؟", os: /Linux/.test(ua) ? "Linux" : "؟", device_type: /Mobi/.test(ua) ? "موبایل" : "دسکتاپ", details: { screen: body.device?.screen, language: body.device?.language, timezone: body.device?.timezone } });
  const recent = db.login_history.filter((r) => !r.success).length;
  if (recent >= 8) { log(false); return { status: 429 }; }
  if (body.username === "Manager" && body.password === "webmanagecafe") { log(true); return { status: 200, body: { access_token: "t", refresh_token: "r" } }; }
  log(false); return { status: 401 };
}

// ---------- test harness ----------
const results = []; let browser;
const ok = (name, cond, extra = "") => { results.push([name, !!cond, extra]); console.log((cond ? "  PASS " : "  FAIL ") + name + (cond ? "" : "  ← " + extra)); };
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");

async function newCtx(opts = {}) {
  const ctx = await browser.newContext({ locale: "fa-IR", ...opts });
  await ctx.exposeFunction("__q", (op) => q(op));
  await ctx.exposeFunction("__fn", (n, b, ua) => fn(n, b, ua));
  await ctx.exposeFunction("__upload", (bucket, p, b64, type) => { storage.set(`/storage/v1/object/public/${bucket}/${p}`, { buf: Buffer.from(b64, "base64"), type }); });
  await ctx.route("https://esm.sh/**", (r) => r.fulfill({ contentType: "text/javascript", body: MOCK }));
  await ctx.route("**/js/config.js", (r) => r.fulfill({ contentType: "text/javascript", body: `export const SUPABASE_URL="https://mock.supabase.co",SUPABASE_ANON_KEY="mock",STORAGE_BUCKET="namir-assets",ADMIN_FUNCTION="admin-login";` }));
  await ctx.route("https://mock.supabase.co/storage/**", (r) => { const f = storage.get(new URL(r.request().url()).pathname); f ? r.fulfill({ contentType: f.type, body: f.buf }) : r.fulfill({ status: 404 }); });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  return ctx;
}
async function open(ctx) {
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + "/"); page.errors = errors; return page;
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });

  // =============== PUBLIC SITE (desktop) ===============
  console.log("\n[Public site · desktop]");
  const ctx = await newCtx({ viewport: { width: 1280, height: 800 } });
  const page = await open(ctx);
  ok("intro overlay is shown first", await page.locator("#intro:not(.gone)").count() === 1);
  ok("intro has logo + name", (await page.locator("#introStage .intro__name").textContent()) === "نمیر کافه");
  await page.screenshot({ path: SHOTS + "/01-intro.png" });
  await page.waitForSelector("#intro.gone", { state: "attached", timeout: 6000 });
  ok("intro fades away and site is revealed", !(await page.evaluate(() => document.body.classList.contains("is-loading"))));
  await sleep(900); await page.screenshot({ path: SHOTS + "/02-home-light.png" });

  ok("menu rendered from DB (visible products only)", (await page.locator(".card").count()) === 3, await page.locator(".card").count());
  ok("hidden product is NOT shown", (await page.locator(".card", { hasText: "مخفی" }).count()) === 0);
  ok("nav: phone is tel: link", (await page.locator("#navPhone").getAttribute("href")) === "tel:09123456789");
  ok("nav: instagram link", (await page.locator("#navInsta").getAttribute("href")) === "https://instagram.com/namir.cafe");
  ok("nav: café name in center", (await page.locator("#brandBtn").textContent()).trim() === "نمیر کافه");
  const nb = async (s) => (await page.locator(s).boundingBox());
  const [l, c, r] = [await nb("#navPhone"), await nb("#brandBtn"), await nb("#aboutBtn")];
  ok("nav layout: contact at LEFT edge · name CENTER · About at RIGHT edge", l.x < 120 && c.x < 700 && Math.abs((c.x + c.width / 2) - 640) < 40 && r.x + r.width > 1160, JSON.stringify([l.x, c.x, r.x + r.width]));
  ok("discount card is styled differently", await page.locator(".card--sale").count() === 1 && await page.locator(".card--sale .price__old").count() === 1);
  const oldStyle = await page.locator(".price__old").first().evaluate((e) => getComputedStyle(e).textDecorationLine + "|" + getComputedStyle(e).opacity);
  ok("old price struck-through + faded", oldStyle.startsWith("line-through") && parseFloat(oldStyle.split("|")[1]) < 1, oldStyle);
  ok("price shown in Persian digits with ٬", (await page.locator(".card--sale .price__now").textContent()).includes("۹۹٬۰۰۰"));

  // search
  await page.fill("#search", "لاته");
  ok("search filters instantly across categories", (await page.locator(".card").count()) === 2, await page.locator(".card").count());
  await page.fill("#search", "ي‌لاته".replace("ي", "ل"));
  await page.fill("#search", "zzz");
  ok("search shows 'not found' message", await page.locator("#noResults").isVisible() && (await page.locator("#noResults").textContent()).includes("پیدا نشد"));
  await page.fill("#search", "");
  ok("clearing search restores menu", (await page.locator(".card").count()) === 3);

  // popup
  const xBefore = await page.locator(".hero__title").evaluate((e) => e.getBoundingClientRect().x + e.getBoundingClientRect().width / 2);
  await page.locator(".card--sale").click(); await sleep(500);
  ok("popup opens", await page.locator("#modal.open").count() === 1);
  ok("popup: name, desc, ingredients, discount reason", (await page.locator("#mName").textContent()) === "لاته" && (await page.locator("#mIng li").count()) === 2 && (await page.locator("#mReason").textContent()).includes("تخفیف صبحانه"));
  ok("popup: strikethrough old + new price", await page.locator("#mPrice .price__old").count() === 1 && await page.locator("#mPrice .price__now").count() === 1);
  const blur = await page.locator(".modal__backdrop").evaluate((e) => getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter);
  ok("popup: background blur applied", /blur\(10px\)/.test(blur), blur);
  const xAfter = await page.locator(".hero__title").evaluate((e) => e.getBoundingClientRect().x + e.getBoundingClientRect().width / 2);
  ok("popup: page scroll locked, no layout shift", (await page.evaluate(() => getComputedStyle(document.documentElement).overflow)) === "hidden" && Math.abs(xAfter - xBefore) < 0.6, xBefore + " vs " + xAfter);
  await page.screenshot({ path: SHOTS + "/03-popup.png" });
  await page.mouse.click(30, 400); await sleep(500);
  ok("popup closes on outside click", await page.locator("#modal.open").count() === 0);
  await page.locator(".card").first().click(); await sleep(400); await page.click(".modal__close"); await sleep(400);
  ok("popup closes with close button", await page.locator("#modal.open").count() === 0);
  await page.locator(".card").first().click(); await sleep(300); await page.keyboard.press("Escape"); await sleep(400);
  ok("popup closes with Escape", await page.locator("#modal.open").count() === 0);

  // scroll top + about
  ok("scroll-top hidden at top", !(await page.locator("#toTop.show").count()));
  await page.click("#aboutBtn"); await sleep(1200);
  const y = await page.evaluate(() => [scrollY, document.getElementById("about").getBoundingClientRect().top]);
  ok("About button smooth-scrolls to footer (footer in view)", y[0] > 100 && y[1] < 700, JSON.stringify(y));
  ok("scroll-top appears after scrolling", await page.locator("#toTop.show").count() === 1);
  ok("footer: landline, mobile, address, instagram, hours", await page.locator("#infoList li").count() >= 4 && (await page.locator("#hoursBox").textContent()).includes("۰۵:۳۰") && (await page.locator("#hoursBox").textContent()).includes("۲۳:۰۰"));
  ok("footer: hours show شنبه تا جمعه", (await page.locator("#hoursBox").textContent()).includes("شنبه تا جمعه"));
  ok("telegram credit link", (await page.locator(".credit a").getAttribute("href")) === "https://t.me/P_DM_8");
  await page.screenshot({ path: SHOTS + "/04-footer.png" });
  await page.click("#toTop"); await sleep(1500);
  ok("scroll-top returns to top and hides", (await page.evaluate(() => scrollY)) === 0 && await page.locator("#toTop.show").count() === 0);

  // theme
  await page.click("#themeBtn"); await sleep(600);
  ok("dark mode applied", (await page.locator("html").getAttribute("data-theme")) === "dark");
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok("dark palette differs from light", bgDark !== "rgb(245, 240, 229)", bgDark);
  const mintDark = await page.evaluate(() => getComputedStyle(document.querySelector(".cat__head")).backgroundColor);
  ok("dark mode: category bands use dark mint (brand colors don't override)", mintDark === "rgb(38, 51, 47)", mintDark);
  await page.screenshot({ path: SHOTS + "/05-home-dark.png" });
  await page.reload(); await page.waitForSelector(".card");
  ok("theme choice remembered after reload", (await page.locator("html").getAttribute("data-theme")) === "dark");
  await page.click("#themeBtn"); await sleep(500);
  ok("light mode restored", (await page.locator("html").getAttribute("data-theme")) === "light");
  ok("intro not repeated in same session", await page.locator("#intro.gone").count() === 1);
  ok("no horizontal overflow (desktop)", (await overflowX(page)) <= 0);
  ok("no JS errors on public site", page.errors.length === 0, page.errors.join(" | "));

  // =============== ADMIN ===============
  console.log("\n[Admin]");
  await page.click("#brandBtn");
  await page.waitForSelector(".login__card");
  ok("clicking café name opens login", true); await page.screenshot({ path: SHOTS + "/06-login.png" });
  await page.fill("[name=username]", "Manager"); await page.fill("[name=password]", "wrong");
  await page.click(".login__card [type=submit]"); await page.waitForSelector("#loginErr:not([hidden])");
  ok("invalid login rejected with message", (await page.locator("#loginErr").textContent()).includes("نادرست"));
  ok("failed login recorded server-side", db.login_history[0]?.success === false);
  ok("no session after failed login", !(await page.evaluate(() => localStorage.getItem("mock_session"))));
  ok("unauthenticated write blocked (RLS)", (await page.evaluate(() => window.__q({ table: "products", action: "delete", filters: [], order: [], authed: false }))).error?.code === "42501");
  ok("unauthenticated login_history read blocked", (await page.evaluate(() => window.__q({ table: "login_history", action: "select", filters: [], order: [], authed: false }))).error?.code === "42501");
  ok("credentials absent from frontend source", !["webmanagecafe"].some((s) => fs.readdirSync(PUB + "/js").some((f) => fs.readFileSync(PUB + "/js/" + f, "utf8").includes(s))));
  await page.fill("[name=username]", "manager"); await page.fill("[name=password]", "webmanagecafe");
  await page.click(".login__card [type=submit]"); await sleep(400);
  ok("wrong-case username rejected", await page.locator(".adm").count() === 0);
  await page.fill("[name=username]", "Manager"); await page.fill("[name=password]", "webmanagecafe");
  await page.click(".login__card [type=submit]"); await page.waitForSelector(".adm");
  ok("valid login opens dashboard", true);
  ok("success login recorded", db.login_history[0]?.success === true);
  ok("dashboard has 6 sections + login history", (await page.locator(".adm__tab").count()) === 7);
  ok("no admin-registration UI", (await page.locator("text=/ثبت.?نام|مدیر جدید|افزودن مدیر/").count()) === 0);
  await page.screenshot({ path: SHOTS + "/07-admin-brand.png" });

  // second visitor window — to verify realtime
  const visitor = await open(await newCtx({ viewport: { width: 390, height: 800 } })); // separate context: separate storage, shared DB via exposeFunction
  await visitor.waitForSelector(".card", { timeout: 8000 });
  const visitorBC = visitor; // NOTE: BroadcastChannel is per-context; realtime test uses same-context second page below
  const live = await ctx.newPage(); await live.goto(BASE + "/"); await live.evaluate(() => sessionStorage.setItem("namir_intro", "1")); await live.reload(); await live.waitForSelector(".card");

  // Tab 2: products
  await page.click('[data-tab="products"]'); await sleep(300);
  ok("products tab lists all incl. hidden", (await page.locator("#plist .row").count()) === 4);
  await page.click("#addP"); await page.waitForSelector(".dlg--form");
  await page.fill(".dlg [name=name]", "موکای ویژه"); await page.fill(".dlg [name=price]", "۱۵۰۰۰۰");
  await page.fill(".dlg [name=description]", "شکلات و قهوه"); await page.fill(".dlg [name=ingredients]", "اسپرسو، شکلات، شیر");
  // invalid discount
  await page.check(".dlg [name=discount_active]", { force: true }); await page.fill(".dlg [name=discount_price]", "۱۶۰۰۰۰");
  await page.click(".dlg [type=submit]");
  ok("discount ≥ price rejected", (await page.locator(".dlg [data-err]").textContent()).includes("کمتر"));
  await page.fill(".dlg [name=discount_price]", "۱۲۰۰۰۰"); await page.fill(".dlg [name=discount_reason]", "افتتاحیه");
  // image upload (1x1 png)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.setInputFiles(".dlg input[type=file]", { name: "m.png", mimeType: "image/png", buffer: png });
  await page.click(".dlg [type=submit]"); await page.waitForSelector(".dlg--form", { state: "detached" });
  const np = db.products.find((p) => p.name === "موکای ویژه");
  ok("product created in DB with discount (Persian digits parsed)", np && np.price === 150000 && np.discount_price === 120000 && np.discount_active && np.discount_reason === "افتتاحیه");
  ok("product image uploaded to storage + URL stored", np?.image_url?.includes("/namir-assets/products/") && storage.size === 1, np?.image_url);
  await sleep(500);
  ok("realtime: open public page received new product w/o refresh", (await live.locator(".card", { hasText: "موکای ویژه" }).count()) === 1);
  ok("realtime: discount card styling on new product", await live.locator(".card--sale", { hasText: "موکای ویژه" }).count() === 1);
  const imgOk = await live.locator(".card", { hasText: "موکای ویژه" }).locator("img").evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false);
  ok("uploaded product image loads on public site", imgOk);

  // edit
  await page.locator(".row", { hasText: "اسپرسو" }).first().locator("[data-edit]").click(); await page.waitForSelector(".dlg--form");
  await page.fill(".dlg [name=name]", "اسپرسو دبل"); await page.fill(".dlg [name=price]", "۸۵۰۰۰"); await page.click(".dlg [type=submit]"); await sleep(600);
  ok("edit product saved", db.products.some((p) => p.name === "اسپرسو دبل" && p.price === 85000));
  ok("realtime: edit visible on public page", (await live.locator(".card", { hasText: "اسپرسو دبل" }).count()) === 1);
  // visibility toggle
  await page.locator(".row", { hasText: "اسپرسو دبل" }).locator("[data-vis]").uncheck({ force: true }); await sleep(600);
  ok("realtime: hiding product removes it from public page", (await live.locator(".card", { hasText: "اسپرسو دبل" }).count()) === 0);
  await page.locator(".row", { hasText: "اسپرسو دبل" }).locator("[data-vis]").check({ force: true }); await sleep(500);
  // reorder
  const before = db.products.filter((p) => p.category_id === "c1").sort((a, b) => a.sort_order - b.sort_order).map((p) => p.name);
  await page.locator(".row", { hasText: "لاته" }).first().locator("[data-up]").click(); await sleep(600);
  const after = db.products.filter((p) => p.category_id === "c1").sort((a, b) => a.sort_order - b.sort_order).map((p) => p.name);
  ok("product order changed", JSON.stringify(before) !== JSON.stringify(after), before + " → " + after);
  // delete
  await page.locator(".row", { hasText: "موکای ویژه" }).locator("[data-del]").click(); await page.click(".dlg [data-v='1']"); await sleep(600);
  ok("delete product (with confirmation)", !db.products.some((p) => p.name === "موکای ویژه"));
  ok("realtime: deleted product disappears publicly", (await live.locator(".card", { hasText: "موکای ویژه" }).count()) === 0);

  // Tab 3: categories
  await page.click('[data-tab="categories"]'); await sleep(300);
  await page.click("#addC"); await page.fill(".dlg [name=name]", "کیک و دسر"); await page.click(".dlg [type=submit]"); await sleep(600);
  ok("category created", db.categories.some((c) => c.name === "کیک و دسر"));
  await page.locator(".row", { hasText: "کیک و دسر" }).locator("[data-edit]").click(); await page.fill(".dlg [name=name]", "دسر"); await page.click(".dlg [type=submit]"); await sleep(500);
  ok("category renamed", db.categories.some((c) => c.name === "دسر"));
  await page.locator(".row", { hasText: "نوشیدنی‌های سرد" }).locator("[data-vis]").uncheck({ force: true }); await sleep(600);
  ok("realtime: hidden category + its products vanish publicly", (await live.locator("#menu .cat").count()) === 1 && (await live.locator(".card", { hasText: "آیس لاته" }).count()) === 0);
  await page.locator(".row", { hasText: "نوشیدنی‌های سرد" }).locator("[data-vis]").check({ force: true });
  await page.locator(".row", { hasText: "دسر" }).locator("[data-down]").click(); await sleep(300);
  await page.locator(".row", { hasText: "دسر" }).locator("[data-up]").click(); await sleep(400);
  await page.locator(".row", { hasText: "دسر" }).locator("[data-del]").click(); await page.click(".dlg [data-v='1']"); await sleep(500);
  ok("category deleted", !db.categories.some((c) => c.name === "دسر"));

  // Tab 1: brand
  await page.click('[data-tab="brand"]'); await sleep(300);
  await page.fill("#f [name=name]", "نمیر"); await page.fill("#f [name=c_primary]", "#FF0000"); await page.fill("#f [name=c_bg]", "#EFE6D2");
  await page.selectOption("#f [name=font]", "Noto Naskh Arabic");
  await page.setInputFiles("#f [data-img=logo] input[type=file]", { name: "logo.png", mimeType: "image/png", buffer: png });
  await page.click("#f [type=submit]"); await sleep(900);
  ok("brand saved (name, color, font, logo)", db.site_settings.find((s) => s.key === "brand").value.name === "نمیر" && db.site_settings.find((s) => s.key === "brand").value.colors.primary === "#FF0000" && db.site_settings.find((s) => s.key === "brand").value.logo_url.includes("/brand/"));
  ok("realtime: café name changed in public nav", (await live.locator("#brandBtn").textContent()).trim() === "نمیر");
  ok("realtime: primary color + background applied", (await live.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim())) === "#FF0000" && (await live.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(239, 230, 210)");
  ok("realtime: font applied", (await live.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-body"))).includes("Noto Naskh Arabic"));
  await page.screenshot({ path: SHOTS + "/08-admin-brand-saved.png" });
  await page.click("#reset"); await page.fill("#f [name=name]", "نمیر کافه"); await page.selectOption("#f [name=font]", "Vazirmatn"); await page.click("#f [type=submit]"); await sleep(700);

  // Tab 4
  await page.click('[data-tab="about"]'); await page.fill("#f [name=intro]", "معرفی جدید کافه"); await page.fill("#f [name=description]", "توضیحات جدید\nخط دوم"); await page.click("#f [type=submit]"); await sleep(600);
  ok("realtime: About Us content updated", (await live.locator("#aboutIntro").textContent()) === "معرفی جدید کافه" && (await live.locator("#aboutDesc").textContent()).includes("خط دوم"));

  // Tab 5
  await page.click('[data-tab="contact"]'); await sleep(200);
  await page.fill("#f [name=mobile]", "۰۹۳۵۱۲۳۴۵۶۷"); await page.fill("#f [name=landline]", "02188776655"); await page.fill("#f [name=address]", "تهران، خیابان جدید");
  await page.fill("#f [name=instagram_id]", "@namir.new"); await page.fill("#f [name=instagram_url]", "https://instagram.com/namir.new");
  await page.fill("#f [name=o0]", "06:00"); await page.check("#f [name=x6]", { force: true });
  await page.click("#f [type=submit]"); await sleep(800);
  ok("realtime: phone (tel:) updated, Persian digits parsed", (await live.locator("#navPhone").getAttribute("href")) === "tel:09351234567");
  ok("realtime: instagram link updated", (await live.locator("#navInsta").getAttribute("href")) === "https://instagram.com/namir.new" && (await live.locator("#navInstaTxt").textContent()) === "@namir.new");
  ok("realtime: address + landline in footer", (await live.locator("#infoList").textContent()).includes("خیابان جدید") && (await live.locator("#infoList").textContent()).includes("۰۲۱۸۸۷۷۶۶۵۵"));
  ok("realtime: working hours updated (Friday closed)", (await live.locator("#hoursBox").textContent()).includes("تعطیل") && (await live.locator("#hoursBox").textContent()).includes("۰۶:۰۰"));
  await page.fill("#f [name=mobile]", "abc"); await page.click("#f [type=submit]"); await sleep(300);
  ok("invalid phone rejected", (await live.locator("#navPhone").getAttribute("href")) === "tel:09351234567" && await page.locator(".toast.err").count() >= 1);

  // Tab 6
  await page.click('[data-tab="animation"]'); await sleep(200);
  await page.uncheck("#f [name=intro_enabled]", { force: true }); await page.fill("#f [name=intro_duration_ms]", "2000"); await page.selectOption("#f [name=popup_animation]", "slide");
  await page.click("#f [type=submit]"); await sleep(800);
  const an = db.site_settings.find((s) => s.key === "animation").value;
  ok("animation settings saved", an.intro_enabled === false && an.intro_duration_ms === 2000 && an.popup_animation === "slide");
  ok("realtime: popup animation setting applied", (await live.locator("#modal").getAttribute("data-anim")) === "slide");
  await page.check("#f [name=intro_enabled]", { force: true }); await page.click("#f [type=submit]"); await sleep(600);

  // Tab 7
  await page.click('[data-tab="logins"]'); await sleep(600);
  const rowsN = await page.locator("#lb tr").count();
  ok("login history table shows attempts (success + failure)", rowsN >= 3 && await page.locator("#lb .badge.ok").count() >= 1 && await page.locator("#lb .badge.no").count() >= 2, rowsN);
  const firstRow = await page.locator("#lb tr").first().textContent();
  ok("history has Jalali date, time, browser, device, OS", /[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/.test(firstRow) && firstRow.includes("Chrome") && firstRow.includes("دسکتاپ") && firstRow.includes("Linux"), firstRow);
  await page.screenshot({ path: SHOTS + "/09-admin-logins.png" });

  // persistence: reload admin → still logged in; then logout
  await page.reload(); await page.waitForSelector(".card"); await page.click("#brandBtn"); await page.waitForSelector(".adm");
  ok("session persists across reload (dashboard opens directly)", true);
  await page.click("#admOut"); await sleep(300);
  ok("logout closes dashboard & clears session", await page.locator(".adm").count() === 0 && !(await page.evaluate(() => localStorage.getItem("mock_session"))));
  await page.click("#brandBtn"); await page.waitForSelector(".login__card");
  ok("after logout admin requires login again", true);
  await page.keyboard.press("Escape"); await sleep(200);
  ok("persistence: data survives (new visitor context sees edited content)", (await visitor.reload().then(() => visitor.waitForSelector(".card").then(() => visitor.locator("#navPhone").getAttribute("href")))) === "tel:09351234567");

  // =============== MOBILE ===============
  console.log("\n[Mobile 390px]");
  await sleep(1500);
  await visitor.evaluate(() => scrollTo(0, 0));
  await visitor.screenshot({ path: SHOTS + "/10-mobile-home.png" });
  ok("mobile: no horizontal overflow", (await overflowX(visitor)) <= 0, await overflowX(visitor));
  const mb = async (s) => (await visitor.locator(s).boundingBox());
  const [ml, mc, mr] = [await mb("#navPhone"), await mb("#brandBtn"), await mb("#aboutBtn")];
  ok("mobile: nav keeps left/center/right order, no overlap", ml.x + ml.width <= mc.x + 2 && mc.x + mc.width <= mr.x + 2, JSON.stringify([ml, mc, mr].map((b) => [Math.round(b.x), Math.round(b.width)])));
  ok("mobile: 2-column product grid", (await visitor.locator(".grid").first().evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length)) === 2);
  await visitor.locator(".card").first().click(); await sleep(600);
  await visitor.screenshot({ path: SHOTS + "/11-mobile-popup.png" });
  const mm = await visitor.locator(".modal__card").boundingBox();
  ok("mobile: popup fits viewport", mm.width <= 390 && mm.height <= 800 && mm.x >= 0, JSON.stringify(mm) + JSON.stringify(await visitor.evaluate(() => [innerWidth, document.documentElement.clientWidth, document.documentElement.scrollWidth, scrollX])));
  await visitor.keyboard.press("Escape"); await sleep(400);
  ok("mobile: no JS errors", visitor.errors.length === 0, visitor.errors.join("|"));

  // mobile admin
  const adminM = await open(await newCtx({ viewport: { width: 390, height: 800 } }));
  await adminM.evaluate(() => localStorage.setItem("mock_session", JSON.stringify({ access_token: "t", refresh_token: "r" })));
  await adminM.reload(); await adminM.waitForSelector(".card"); await adminM.click("#brandBtn"); await adminM.waitForSelector(".adm");
  await adminM.click('[data-tab="products"]'); await sleep(400);
  await adminM.screenshot({ path: SHOTS + "/12-mobile-admin.png" });
  ok("mobile admin: usable, no horizontal overflow", (await adminM.evaluate(() => document.querySelector(".adm").scrollWidth - document.querySelector(".adm").clientWidth)) <= 0, JSON.stringify(await adminM.evaluate(() => { const a=document.querySelector(".adm"); const wide=[...a.querySelectorAll("*")].filter(e=>e.getBoundingClientRect().right>a.clientWidth+1||e.getBoundingClientRect().left<-1).slice(0,5).map(e=>e.className+":"+Math.round(e.getBoundingClientRect().left)+"-"+Math.round(e.getBoundingClientRect().right)); return [a.scrollWidth,a.clientWidth,innerWidth,wide]; })));
  await adminM.click('[data-tab="brand"]'); await sleep(300);
  ok("mobile admin: form no overflow", (await adminM.evaluate(() => { const b = document.querySelector(".adm__body"); return b.scrollWidth - b.clientWidth; })) <= 0);

  // tablet
  const tab = await open(await newCtx({ viewport: { width: 820, height: 1100 } }));
  await tab.waitForSelector(".card"); await sleep(800);
  ok("tablet: no horizontal overflow", (await overflowX(tab)) <= 0); await tab.screenshot({ path: SHOTS + "/13-tablet.png" });

  // un-configured site shows friendly error
  const bare = await browser.newContext(); await bare.route(/fonts\./, (r) => r.abort());
  const bp = await bare.newPage(); await bp.goto(BASE + "/"); await sleep(800);
  ok("unconfigured: friendly Persian error instead of blank page", (await bp.locator("#siteError").isVisible()) && (await bp.locator("#siteError").textContent()).includes("Supabase"));

  await browser.close(); server.close();
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await browser?.close(); server.close(); process.exit(2); });
