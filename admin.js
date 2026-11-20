// Hidden admin dashboard. Loaded lazily — only after the visitor clicks the café name.
// Authentication is verified SERVER-SIDE by the `admin-login` Edge Function; this file
// contains no credentials. All writes are additionally protected by Row Level Security.
import { sb } from "./supabase-client.js";
import { ADMIN_FUNCTION, STORAGE_BUCKET } from "./config.js";
import { state, onChange, fetchSettings, fetchCategories, fetchProducts, refreshAll, DEFAULTS } from "./store.js";
import { esc, toFa, toEn, fmtPrice, toast, jalaliDate, jalaliTime, FALLBACK_IMG, hasDiscount, safeUrl, lockScroll, unlockScroll } from "./utils.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const rootEl = () => $("#adminRoot");

// load admin stylesheet once
(function css() {
  if (document.getElementById("adminCss")) return;
  const l = document.createElement("link");
  l.id = "adminCss"; l.rel = "stylesheet"; l.href = new URL("../css/admin.css", import.meta.url).href;
  document.head.appendChild(l);
})();

const FONTS = ["Vazirmatn", "Noto Sans Arabic", "Noto Naskh Arabic", "Lalezar", "Markazi Text", "Cairo", "Harmattan", "Mirza"];
const TABS = [
  { id: "brand", label: "ظاهر و هویت برند", icon: "🎨" },
  { id: "products", label: "محصولات", icon: "☕" },
  { id: "categories", label: "دسته‌بندی‌ها", icon: "🗂️" },
  { id: "about", label: "اطلاعات کافه", icon: "📖" },
  { id: "contact", label: "تماس، نشانی و ساعت کاری", icon: "📍" },
  { id: "animation", label: "تنظیمات انیمیشن", icon: "✨" },
  { id: "logins", label: "تاریخچه ورود", icon: "🔐" },
];
let tab = "brand";
let unsub = null;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const field = (label, control, hint = "") => `<label class="f"><span class="f__l">${label}</span>${control}${hint ? `<small>${hint}</small>` : ""}</label>`;
const input = (name, val = "", attrs = "") => `<input name="${name}" value="${esc(val)}" ${attrs}>`;
const textarea = (name, val = "", rows = 4) => `<textarea name="${name}" rows="${rows}">${esc(val)}</textarea>`;
const sw = (name, checked, label) => `<label class="sw"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}><i></i><span>${label}</span></label>`;

function busy(btn, on, txt) {
  if (!btn) return;
  if (on) { btn.dataset.t = btn.textContent; btn.disabled = true; btn.textContent = txt || "در حال ذخیره…"; }
  else { btn.disabled = false; btn.textContent = btn.dataset.t || btn.textContent; }
}

function sessionExpired(err) {
  const s = err?.status ?? err?.code;
  return s === 401 || s === "PGRST301" || /jwt|expired|not authenticated/i.test(err?.message || "");
}
function fail(err, ctx = "ذخیره‌سازی") {
  console.error(ctx, err);
  if (sessionExpired(err)) { toast("نشست مدیریت منقضی شده است؛ دوباره وارد شوید.", true); showLogin(); return; }
  if (err?.code === "42501") { toast("دسترسی مجاز نیست.", true); return; }
  toast(`${ctx} ناموفق بود: ${err?.message || "خطای ناشناخته"}`, true);
}

function confirmBox(message, okLabel = "حذف") {
  return new Promise((resolve) => {
    const d = document.createElement("div");
    d.className = "dlg"; d.setAttribute("role", "alertdialog"); d.setAttribute("aria-modal", "true");
    d.innerHTML = `<div class="dlg__box"><p>${esc(message)}</p><div class="dlg__act"><button class="btn btn--ghost btn--sm" data-v="0">انصراف</button><button class="btn btn--danger btn--sm" data-v="1">${esc(okLabel)}</button></div></div>`;
    d.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b || e.target === d) { d.remove(); resolve(b?.dataset.v === "1"); } });
    document.body.appendChild(d);
    d.querySelector('[data-v="0"]').focus();
  });
}

// ---------- images ----------
async function prepareImage(file) {
  if (!/^image\//.test(file.type)) throw new Error("فقط فایل تصویری مجاز است.");
  if (file.size > 8 * 1024 * 1024) throw new Error("حجم تصویر نباید بیش از ۸ مگابایت باشد.");
  if (/svg|gif/.test(file.type)) return { blob: file, ext: file.type.includes("svg") ? "svg" : "gif", type: file.type };
  const bmp = await createImageBitmap(file);
  const max = 1400, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  let blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.86));
  if (blob && blob.type === "image/webp") return { blob, ext: "webp", type: "image/webp" };
  blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
  return { blob, ext: "jpg", type: "image/jpeg" };
}
async function uploadImage(file, folder) {
  const { blob, ext, type } = await prepareImage(file);
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from(STORAGE_BUCKET).upload(path, blob, { contentType: type, cacheControl: "31536000", upsert: false });
  if (error) throw error;
  return sb.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}
async function removeStored(url) {
  try {
    const marker = `/${STORAGE_BUCKET}/`; const i = (url || "").indexOf(marker);
    if (i > -1) await sb.storage.from(STORAGE_BUCKET).remove([decodeURIComponent(url.slice(i + marker.length).split("?")[0])]);
  } catch (e) { console.warn("old image cleanup failed", e); }
}

/** Image picker widget. Returns {html, bind(root)->controller}. Upload happens at save time. */
function imageField(label, url, name = "image") {
  const html = `<div class="imgf" data-img="${name}">
    <span class="f__l">${label}</span>
    <div class="imgf__row">
      <div class="imgf__prev"><img alt="" src="${esc(url ? safeUrl(url) : FALLBACK_IMG)}"></div>
      <div class="imgf__act">
        <label class="btn btn--ghost btn--sm">انتخاب تصویر<input type="file" accept="image/*" hidden></label>
        <button type="button" class="btn btn--ghost btn--sm" data-rm ${url ? "" : "hidden"}>حذف تصویر</button>
        <small class="imgf__note"></small>
      </div>
    </div></div>`;
  const bind = (root) => {
    const box = root.querySelector(`[data-img="${name}"]`);
    const ctl = { file: null, removed: false, original: url || "" };
    const img = box.querySelector("img"), note = box.querySelector(".imgf__note"), rm = box.querySelector("[data-rm]");
    box.querySelector("input[type=file]").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (!/^image\//.test(f.type)) { toast("فقط فایل تصویری مجاز است.", true); e.target.value = ""; return; }
      if (f.size > 8 * 1024 * 1024) { toast("حجم تصویر نباید بیش از ۸ مگابایت باشد.", true); e.target.value = ""; return; }
      ctl.file = f; ctl.removed = false; img.src = URL.createObjectURL(f); rm.hidden = false; note.textContent = "با ذخیره، تصویر آپلود می‌شود.";
    });
    rm.addEventListener("click", () => { ctl.file = null; ctl.removed = true; img.src = FALLBACK_IMG; rm.hidden = true; note.textContent = "با ذخیره، تصویر حذف می‌شود."; });
    /** resolves to the url to store (or "" if removed), uploading if needed */
    ctl.resolve = async (folder) => {
      if (ctl.file) { const u = await uploadImage(ctl.file, folder); if (ctl.original) removeStored(ctl.original); return u; }
      if (ctl.removed) { if (ctl.original) removeStored(ctl.original); return ""; }
      return ctl.original;
    };
    return ctl;
  };
  return { html, bind };
}

async function saveSetting(key, value, btn) {
  busy(btn, true);
  const { error } = await sb.from("site_settings").upsert({ key, value }, { onConflict: "key" });
  busy(btn, false);
  if (error) return fail(error), false;
  await fetchSettings().catch(() => {});
  toast("ذخیره شد و همین حالا روی سایت اعمال شد ✓");
  return true;
}
/** Bump the public "sync" row so every open visitor page refreshes (see store.js). */
const touch = () => sb.from("site_settings").upsert({ key: "sync", value: { t: Date.now() } }, { onConflict: "key" }).then(() => {}, () => {});
const afterWrite = (...fs) => { touch(); return Promise.all(fs.map((f) => f())); };
const formData = (root) => Object.fromEntries(new FormData(root).entries());

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------
function deviceInfo() {
  return {
    screen: `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`,
    language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: navigator.userAgentData?.platform || navigator.platform || "",
    touch: navigator.maxTouchPoints || 0, memory: navigator.deviceMemory || null, cores: navigator.hardwareConcurrency || null,
  };
}

export async function openAdmin() {
  if (!sb) return toast("پایگاه‌داده پیکربندی نشده است.", true);
  const { data } = await sb.auth.getSession();
  if (data?.session) {
    const { data: u, error } = await sb.auth.getUser(); // verified by the server
    if (!error && u?.user) return showDashboard();
    await sb.auth.signOut().catch(() => {});
  }
  showLogin();
}

function showLogin() {
  teardown();
  hold();
  rootEl().innerHTML = `
  <div class="login" role="dialog" aria-modal="true" aria-labelledby="lgT">
    <div class="login__backdrop" data-x></div>
    <form class="login__card" id="loginForm" autocomplete="off" novalidate>
      <button type="button" class="login__x" data-x aria-label="بستن">✕</button>
      <h2 id="lgT">ورود مدیر</h2>
      <p class="muted">این بخش فقط برای مدیر کافه است.</p>
      ${field("نام کاربری", input("username", "", 'autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" required'))}
      ${field("گذرواژه", input("password", "", 'type="password" autocomplete="current-password" dir="ltr" required'))}
      <p class="login__err" id="loginErr" role="alert" hidden></p>
      <button class="btn btn--primary" type="submit">ورود</button>
    </form>
  </div>`;
  const form = $("#loginForm"), err = $("#loginErr");
  form.username.focus();
  $(".login").addEventListener("click", (e) => { if (e.target.closest("[data-x]")) closeAdmin(); });
  $(".login").addEventListener("keydown", (e) => { if (e.key === "Escape") closeAdmin(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true;
    const username = form.username.value.trim(), password = form.password.value;
    if (!username || !password) { err.textContent = "نام کاربری و گذرواژه را وارد کنید."; err.hidden = false; return; }
    const btn = form.querySelector("button[type=submit]"); busy(btn, true, "در حال بررسی…");
    try {
      const { data, error } = await sb.functions.invoke(ADMIN_FUNCTION, { body: { username, password, device: deviceInfo() } });
      if (error || !data?.access_token) {
        const status = error?.context?.status;
        err.textContent = status === 429 ? "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید."
          : status === 401 ? "نام کاربری یا گذرواژه نادرست است."
          : "ورود ممکن نشد. اتصال اینترنت یا تنظیمات سرور را بررسی کنید.";
        err.hidden = false; form.password.value = ""; form.password.focus(); return;
      }
      const { error: se } = await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
      if (se) throw se;
      showDashboard();
    } catch (ex) {
      console.error(ex); err.textContent = "خطا در ورود. دوباره تلاش کنید."; err.hidden = false;
    } finally { busy(btn, false); }
  });
}

let held = false;
const hold = () => { if (!held) { held = true; lockScroll(); } };
const release = () => { if (held) { held = false; unlockScroll(); } };
function teardown() { unsub?.(); unsub = null; }
function closeAdmin() {
  teardown();
  rootEl().innerHTML = "";
  document.body.classList.remove("admin-open");
  release();
}
async function logout() {
  await sb.auth.signOut().catch(() => {});
  closeAdmin(); toast("از پنل مدیریت خارج شدید.");
}

// ---------------------------------------------------------------
// Dashboard shell
// ---------------------------------------------------------------
function showDashboard() {
  teardown();
  document.body.classList.add("admin-open");
  hold();
  rootEl().innerHTML = `
  <div class="adm" dir="rtl">
    <aside class="adm__side">
      <div class="adm__brand"><span>${esc(state.settings.brand.name)}</span><small>پنل مدیریت</small></div>
      <nav class="adm__tabs" id="admTabs" role="tablist">
        ${TABS.map((t) => `<button role="tab" data-tab="${t.id}" class="adm__tab"><i>${t.icon}</i><span>${t.label}</span></button>`).join("")}
      </nav>
      <div class="adm__foot">
        <button class="btn btn--ghost btn--sm" id="admView">مشاهده سایت</button>
        <button class="btn btn--ghost btn--sm" id="admOut">خروج</button>
      </div>
    </aside>
    <section class="adm__main"><h1 class="adm__title" id="admTitle"></h1><div id="admBody" class="adm__body"></div></section>
  </div>`;
  $("#admTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
  $("#admView").addEventListener("click", closeAdmin);
  $("#admOut").addEventListener("click", logout);
  unsub = onChange((what) => {
    if ((what === "products" && ["products"].includes(tab)) || (what === "categories" && ["products", "categories"].includes(tab))) renderList();
  });
  // Re-fetch with the admin session so hidden products/categories become visible in the panel.
  refreshAll().catch((e) => fail(e, "دریافت اطلاعات")).finally(() => go(tab));
}

function go(id) {
  tab = id;
  $$(".adm__tab").forEach((b) => { const on = b.dataset.tab === id; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  $("#admTitle").textContent = TABS.find((t) => t.id === id).label;
  const body = $("#admBody"); body.scrollTop = 0; window.scrollTo(0, 0);
  ({ brand: tabBrand, products: tabProducts, categories: tabCategories, about: tabAbout, contact: tabContact, animation: tabAnimation, logins: tabLogins })[id](body);
}
let renderList = () => {};

// ---------------------------------------------------------------
// TAB 1 — UI & brand identity
// ---------------------------------------------------------------
const COLOR_LABELS = {
  primary: "فیروزه‌ای اصلی", bg: "پس‌زمینه‌ی کرم", accent: "نارنجی ملایم", text: "رنگ متن (زغالی)", mint: "سبز نعنایی",
  wood: "قهوه‌ای چوبی", button: "رنگ دکمه‌ها", button_text: "رنگ متن دکمه‌ها", discount: "رنگ قیمت تخفیف‌خورده",
};
function tabBrand(body) {
  const b = state.settings.brand, c = { ...DEFAULTS.brand.colors, ...(b.colors || {}) };
  const logo = imageField("لوگوی اصلی (وب‌سایت و صفحه‌ی ابتدایی)", b.logo_url, "logo");
  body.innerHTML = `<form class="panel" id="f" novalidate>
    <div class="grid2">
      ${field("نام کافه (فارسی)", input("name", b.name, "required maxlength=60"))}
      ${field("نام لاتین", input("name_en", b.name_en, 'dir="ltr" maxlength=60'))}
    </div>
    ${field("شعار", input("tagline", b.tagline, "maxlength=120"))}
    ${logo.html}
    <h3>تایپوگرافی</h3>
    <div class="grid2">
      ${field("فونت متن", `<select name="font">${FONTS.map((f) => `<option ${f === b.font ? "selected" : ""}>${f}</option>`).join("")}</select>`)}
      ${field("فونت عناوین", `<select name="heading_font">${FONTS.map((f) => `<option ${f === (b.heading_font || b.font) ? "selected" : ""}>${f}</option>`).join("")}</select>`)}
    </div>
    ${field(`اندازه‌ی پایه‌ی متن: <b id="fsv">${toFa(b.base_font_size || 16)}</b> پیکسل`, `<input type="range" name="base_font_size" min="14" max="20" value="${b.base_font_size || 16}">`)}
    <h3>رنگ‌ها <small class="muted">(حالت روشن؛ حالت تاریک پالت مکمل خودش را دارد)</small></h3>
    <div class="colors">
      ${Object.keys(COLOR_LABELS).map((k) => `<label class="color"><span>${COLOR_LABELS[k]}</span><div><input type="color" data-c="${k}" value="${c[k]}"><input type="text" name="c_${k}" value="${c[k]}" dir="ltr" maxlength="7" pattern="#[0-9a-fA-F]{6}"></div></label>`).join("")}
    </div>
    <div class="preview" id="pv"><button type="button" class="btn" id="pvBtn">دکمه</button><span class="pv-card"><b>کارت محصول</b><span id="pvPrice">۱۲۰٬۰۰۰ <s>۱۵۰٬۰۰۰</s></span></span></div>
    <div class="actions"><button class="btn btn--primary" type="submit">ذخیره‌ی تغییرات</button><button class="btn btn--ghost" type="button" id="reset">بازگشت رنگ‌ها به پالت اصلی</button></div>
  </form>`;
  const f = $("#f"), ctl = logo.bind(body);
  const colorInputs = () => $$("[data-c]", f);
  const preview = () => {
    const v = (k) => f["c_" + k].value;
    const pv = $("#pv");
    pv.style.setProperty("background", v("bg")); pv.style.setProperty("color", v("text")); pv.style.setProperty("border-color", v("wood"));
    $("#pvBtn").style.cssText = `background:${v("button")};color:${v("button_text")}`;
    $(".pv-card", pv).style.cssText = `background:${v("mint")};border-color:${v("wood")}`;
    $("#pvPrice").style.color = v("discount");
  };
  colorInputs().forEach((ci) => {
    const txt = f["c_" + ci.dataset.c];
    ci.addEventListener("input", () => { txt.value = ci.value; preview(); });
    txt.addEventListener("input", () => { if (/^#[0-9a-f]{6}$/i.test(txt.value)) { ci.value = txt.value; preview(); } });
  });
  f.base_font_size.addEventListener("input", () => ($("#fsv").textContent = toFa(f.base_font_size.value)));
  $("#reset").addEventListener("click", () => { Object.entries(DEFAULTS.brand.colors).forEach(([k, v]) => { f["c_" + k].value = v; $(`[data-c="${k}"]`).value = v; }); preview(); });
  preview();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(f), btn = f.querySelector("[type=submit]");
    if (!d.name.trim()) return toast("نام کافه نمی‌تواند خالی باشد.", true);
    const colors = {};
    for (const k of Object.keys(COLOR_LABELS)) { const v = d["c_" + k].trim(); if (!/^#[0-9a-f]{6}$/i.test(v)) return toast(`رنگ «${COLOR_LABELS[k]}» نامعتبر است (مثال: #70C5BB).`, true); colors[k] = v; }
    busy(btn, true);
    try {
      const logo_url = await ctl.resolve("brand");
      await saveSetting("brand", { name: d.name.trim(), name_en: d.name_en.trim(), tagline: d.tagline.trim(), logo_url, font: d.font, heading_font: d.heading_font, base_font_size: Number(d.base_font_size), colors }, btn) && go("brand");
    } catch (ex) { fail(ex, "آپلود لوگو"); }
    busy(btn, false);
  });
}

// ---------------------------------------------------------------
// TAB 2 — Products
// ---------------------------------------------------------------
let pFilter = { cat: "", q: "" };
function tabProducts(body) {
  body.innerHTML = `
  <div class="toolbar">
    <button class="btn btn--primary" id="addP">＋ محصول جدید</button>
    <select id="fCat" aria-label="فیلتر دسته"><option value="">همه‌ی دسته‌ها</option>${state.categories.map((c) => `<option value="${esc(c.id)}" ${pFilter.cat === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <input id="fQ" type="search" placeholder="جستجوی نام محصول…" value="${esc(pFilter.q)}">
  </div>
  <div id="plist" class="list"></div>`;
  renderList = renderProducts;
  renderProducts();
  $("#addP").addEventListener("click", () => productDialog());
  $("#fCat").addEventListener("change", (e) => { pFilter.cat = e.target.value; renderProducts(); });
  $("#fQ").addEventListener("input", (e) => { pFilter.q = e.target.value; renderProducts(); });
  $("#plist").addEventListener("click", onProductAction);
  $("#plist").addEventListener("change", async (e) => {
    const t = e.target.closest("[data-vis]"); if (!t) return;
    const { error } = await sb.from("products").update({ visible: t.checked }).eq("id", t.dataset.vis);
    if (error) { t.checked = !t.checked; return fail(error); }
    toast(t.checked ? "محصول نمایش داده می‌شود." : "محصول از منو مخفی شد.");
    afterWrite(fetchProducts);
  });
}
const catName = (id) => state.categories.find((c) => c.id === id)?.name || "—";

function renderProducts() {
  const box = $("#plist"); if (!box) return;
  const q = pFilter.q.trim();
  let rows = state.products.filter((p) => (!pFilter.cat || p.category_id === pFilter.cat) && (!q || p.name.includes(q)));
  rows = [...rows].sort((a, b) => (state.categories.findIndex((c) => c.id === a.category_id) - state.categories.findIndex((c) => c.id === b.category_id)) || a.sort_order - b.sort_order);
  if (!rows.length) { box.innerHTML = `<p class="muted center">محصولی یافت نشد.</p>`; return; }
  box.innerHTML = rows.map((p, i) => `
    <div class="row ${p.visible ? "" : "row--off"}" data-id="${esc(p.id)}">
      <img class="row__img" src="${esc(p.image_url ? safeUrl(p.image_url) : FALLBACK_IMG)}" alt="" loading="lazy">
      <div class="row__main"><b>${esc(p.name)}</b><small>${esc(catName(p.category_id))}</small></div>
      <div class="row__price">${hasDiscount(p) ? `<s>${fmtPrice(p.price)}</s> <b class="sale">${fmtPrice(p.discount_price)}</b>` : `<b>${fmtPrice(p.price)}</b>`}<small>تومان</small></div>
      <label class="sw sw--sm" title="نمایش در منو"><input type="checkbox" data-vis="${esc(p.id)}" ${p.visible ? "checked" : ""}><i></i></label>
      <div class="row__act">
        <button class="ib" data-up="${esc(p.id)}" title="بالاتر" aria-label="انتقال به بالا">▲</button>
        <button class="ib" data-down="${esc(p.id)}" title="پایین‌تر" aria-label="انتقال به پایین">▼</button>
        <button class="ib" data-edit="${esc(p.id)}" title="ویرایش" aria-label="ویرایش">✎</button>
        <button class="ib ib--danger" data-del="${esc(p.id)}" title="حذف" aria-label="حذف">🗑</button>
      </div>
    </div>`).join("");
}

async function onProductAction(e) {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) return productDialog(state.products.find((p) => p.id === b.dataset.edit));
  if (b.dataset.del) {
    const p = state.products.find((x) => x.id === b.dataset.del);
    if (!(await confirmBox(`محصول «${p.name}» برای همیشه حذف شود؟`))) return;
    const { error } = await sb.from("products").delete().eq("id", p.id);
    if (error) return fail(error, "حذف");
    if (p.image_url) removeStored(p.image_url);
    toast("محصول حذف شد."); return afterWrite(fetchProducts);
  }
  const dir = b.dataset.up ? -1 : b.dataset.down ? 1 : 0;
  if (dir) await moveItem("products", state.products, b.dataset.up || b.dataset.down, dir, (x) => x.category_id, () => afterWrite(fetchProducts));
}

/** Re-index a sibling group then swap with neighbour — keeps sort_order consistent. */
async function moveItem(table, all, id, dir, groupKey, refetch) {
  const item = all.find((x) => x.id === id);
  const group = all.filter((x) => groupKey(x) === groupKey(item)).sort((a, b) => a.sort_order - b.sort_order);
  const i = group.findIndex((x) => x.id === id), j = i + dir;
  if (j < 0 || j >= group.length) return;
  [group[i], group[j]] = [group[j], group[i]];
  const jobs = group.map((x, idx) => (x.sort_order !== idx + 1 ? sb.from(table).update({ sort_order: idx + 1 }).eq("id", x.id) : null)).filter(Boolean);
  const res = await Promise.all(jobs);
  const bad = res.find((r) => r.error); if (bad) return fail(bad.error, "تغییر ترتیب");
  await refetch();
}

function productDialog(p) {
  const isNew = !p;
  p = p || { name: "", category_id: pFilter.cat || state.categories[0]?.id || "", description: "", ingredients: "", price: "", discount_active: false, discount_price: "", discount_reason: "", visible: true, image_url: "" };
  if (!state.categories.length) return toast("ابتدا یک دسته‌بندی بسازید.", true);
  const img = imageField("تصویر محصول", p.image_url);
  const d = document.createElement("div");
  d.className = "dlg dlg--form"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
  d.innerHTML = `<form class="dlg__box dlg__box--lg" novalidate>
    <h2>${isNew ? "محصول جدید" : "ویرایش محصول"}</h2>
    <div class="grid2">
      ${field("نام محصول", input("name", p.name, "required maxlength=80"))}
      ${field("دسته‌بندی", `<select name="category_id">${state.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === p.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`)}
    </div>
    ${field("قیمت اصلی (تومان)", input("price", p.price === "" ? "" : toFa(p.price), 'inputmode="numeric" required'))}
    ${field("توضیحات", textarea("description", p.description, 3))}
    ${field("ترکیبات", textarea("ingredients", p.ingredients, 2), "با ویرگول از هم جدا کنید؛ مثال: اسپرسو، شیر، شکر")}
    ${img.html}
    <fieldset class="disc"><legend>تخفیف</legend>
      ${sw("discount_active", p.discount_active, "فعال بودن تخفیف")}
      <div class="grid2">
        ${field("قیمت با تخفیف (تومان)", input("discount_price", p.discount_price == null || p.discount_price === "" ? "" : toFa(p.discount_price), 'inputmode="numeric"'))}
        ${field("دلیل تخفیف", input("discount_reason", p.discount_reason, "maxlength=100"))}
      </div>
    </fieldset>
    ${sw("visible", p.visible, "نمایش در منوی سایت")}
    <p class="login__err" data-err hidden></p>
    <div class="dlg__act"><button type="button" class="btn btn--ghost" data-cancel>انصراف</button><button class="btn btn--primary" type="submit">ذخیره</button></div>
  </form>`;
  document.body.appendChild(d);
  const f = d.querySelector("form"), err = d.querySelector("[data-err]"), ctl = img.bind(d);
  f.name.focus();
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-cancel]")) d.remove(); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true;
    const v = formData(f), btn = f.querySelector("[type=submit]");
    const show = (m) => { err.textContent = m; err.hidden = false; };
    const price = parseInt(toEn(v.price), 10);
    const active = f.discount_active.checked;
    const dprice = v.discount_price.trim() === "" ? null : parseInt(toEn(v.discount_price), 10);
    if (!v.name.trim()) return show("نام محصول را وارد کنید.");
    if (!Number.isFinite(price) || price < 0) return show("قیمت اصلی معتبر نیست.");
    if (active && (dprice == null || !Number.isFinite(dprice))) return show("برای فعال‌سازی تخفیف، قیمت با تخفیف را وارد کنید.");
    if (active && dprice >= price) return show("قیمت با تخفیف باید کمتر از قیمت اصلی باشد.");
    busy(btn, true);
    try {
      const image_url = await ctl.resolve("products");
      const row = { name: v.name.trim(), category_id: v.category_id, price, description: v.description.trim(), ingredients: v.ingredients.trim(), image_url: image_url || null,
        discount_active: active, discount_price: dprice, discount_reason: v.discount_reason.trim(), visible: f.visible.checked };
      if (isNew) row.sort_order = Math.max(0, ...state.products.filter((x) => x.category_id === row.category_id).map((x) => x.sort_order)) + 1;
      const { error } = isNew ? await sb.from("products").insert(row) : await sb.from("products").update(row).eq("id", p.id);
      if (error) throw error;
      d.remove(); toast(isNew ? "محصول افزوده شد." : "تغییرات ذخیره شد ✓"); afterWrite(fetchProducts);
    } catch (ex) { busy(btn, false); fail(ex); }
  });
}

// ---------------------------------------------------------------
// TAB 3 — Categories
// ---------------------------------------------------------------
function tabCategories(body) {
  body.innerHTML = `<div class="toolbar"><button class="btn btn--primary" id="addC">＋ دسته‌بندی جدید</button></div><div id="clist" class="list"></div>`;
  renderList = renderCategories; renderCategories();
  $("#addC").addEventListener("click", () => categoryDialog());
  $("#clist").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.edit) return categoryDialog(state.categories.find((c) => c.id === b.dataset.edit));
    if (b.dataset.del) {
      const c = state.categories.find((x) => x.id === b.dataset.del);
      const n = state.products.filter((p) => p.category_id === c.id).length;
      if (!(await confirmBox(`دسته‌ی «${c.name}» حذف شود؟${n ? ` ${toFa(n)} محصول این دسته بدون دسته‌بندی می‌شوند و تا انتخاب دسته‌ی جدید در منو نمایش داده نمی‌شوند.` : ""}`))) return;
      const { error } = await sb.from("categories").delete().eq("id", c.id);
      if (error) return fail(error, "حذف");
      if (c.image_url) removeStored(c.image_url);
      toast("دسته حذف شد."); await afterWrite(fetchCategories, fetchProducts); return;
    }
    const dir = b.dataset.up ? -1 : b.dataset.down ? 1 : 0;
    if (dir) await moveItem("categories", state.categories, b.dataset.up || b.dataset.down, dir, () => 1, () => afterWrite(fetchCategories));
  });
  $("#clist").addEventListener("change", async (e) => {
    const t = e.target.closest("[data-vis]"); if (!t) return;
    const { error } = await sb.from("categories").update({ visible: t.checked }).eq("id", t.dataset.vis);
    if (error) { t.checked = !t.checked; return fail(error); }
    toast(t.checked ? "دسته نمایش داده می‌شود." : "دسته مخفی شد."); afterWrite(fetchCategories);
  });
}
function renderCategories() {
  const box = $("#clist"); if (!box) return;
  if (!state.categories.length) { box.innerHTML = `<p class="muted center">هنوز دسته‌ای ساخته نشده است.</p>`; return; }
  box.innerHTML = state.categories.map((c) => `
    <div class="row ${c.visible ? "" : "row--off"}">
      <img class="row__img row__img--round" src="${esc(c.image_url ? safeUrl(c.image_url) : FALLBACK_IMG)}" alt="" loading="lazy">
      <div class="row__main"><b>${esc(c.name)}</b><small>${toFa(state.products.filter((p) => p.category_id === c.id).length)} محصول</small></div>
      <label class="sw sw--sm" title="نمایش در منو"><input type="checkbox" data-vis="${esc(c.id)}" ${c.visible ? "checked" : ""}><i></i></label>
      <div class="row__act">
        <button class="ib" data-up="${esc(c.id)}" aria-label="انتقال به بالا">▲</button><button class="ib" data-down="${esc(c.id)}" aria-label="انتقال به پایین">▼</button>
        <button class="ib" data-edit="${esc(c.id)}" aria-label="ویرایش">✎</button><button class="ib ib--danger" data-del="${esc(c.id)}" aria-label="حذف">🗑</button>
      </div></div>`).join("");
}
function categoryDialog(c) {
  const isNew = !c; c = c || { name: "", image_url: "", visible: true };
  const img = imageField("تصویر یا آیکن دسته", c.image_url);
  const d = document.createElement("div"); d.className = "dlg dlg--form"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
  d.innerHTML = `<form class="dlg__box" novalidate><h2>${isNew ? "دسته‌ی جدید" : "ویرایش دسته"}</h2>
    ${field("نام دسته", input("name", c.name, "required maxlength=60"))}${img.html}${sw("visible", c.visible, "نمایش در منوی سایت")}
    <p class="login__err" data-err hidden></p>
    <div class="dlg__act"><button type="button" class="btn btn--ghost" data-cancel>انصراف</button><button class="btn btn--primary" type="submit">ذخیره</button></div></form>`;
  document.body.appendChild(d);
  const f = d.querySelector("form"), err = d.querySelector("[data-err]"), ctl = img.bind(d); f.name.focus();
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-cancel]")) d.remove(); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector("[type=submit]");
    if (!f.name.value.trim()) { err.textContent = "نام دسته را وارد کنید."; err.hidden = false; return; }
    busy(btn, true);
    try {
      const image_url = await ctl.resolve("categories");
      const row = { name: f.name.value.trim(), image_url: image_url || null, visible: f.visible.checked };
      if (isNew) row.sort_order = Math.max(0, ...state.categories.map((x) => x.sort_order)) + 1;
      const { error } = isNew ? await sb.from("categories").insert(row) : await sb.from("categories").update(row).eq("id", c.id);
      if (error) throw error;
      d.remove(); toast("ذخیره شد ✓"); afterWrite(fetchCategories);
    } catch (ex) { busy(btn, false); fail(ex); }
  });
}

// ---------------------------------------------------------------
// TAB 4 — About / café info
// ---------------------------------------------------------------
function tabAbout(body) {
  const a = state.settings.about;
  body.innerHTML = `<form class="panel" id="f">
    ${field("عنوان بخش", input("title", a.title, "maxlength=60"))}
    ${field("معرفی کوتاه کافه", textarea("intro", a.intro, 2))}
    ${field("توضیحات کافه (درباره‌ی ما)", textarea("description", a.description, 6))}
    ${field("اطلاعات عمومی دیگر", textarea("extra", a.extra, 3), "مثلاً امکانات، قوانین یا هر توضیح دیگر")}
    <div class="actions"><button class="btn btn--primary" type="submit">ذخیره‌ی تغییرات</button></div></form>`;
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault(); const d = formData(e.target);
    await saveSetting("about", { title: d.title.trim(), intro: d.intro.trim(), description: d.description.trim(), extra: d.extra.trim() }, e.target.querySelector("[type=submit]"));
  });
}

// ---------------------------------------------------------------
// TAB 5 — Contact, address, working hours
// ---------------------------------------------------------------
function tabContact(body) {
  const c = state.settings.contact, days = state.settings.hours.days?.length ? state.settings.hours.days : DEFAULTS.hours.days;
  body.innerHTML = `<form class="panel" id="f" novalidate>
    <div class="grid2">
      ${field("تلفن همراه (نوار بالا و فوتر)", input("mobile", c.mobile, 'inputmode="tel" dir="ltr"'))}
      ${field("تلفن ثابت", input("landline", c.landline, 'inputmode="tel" dir="ltr"'))}
      ${field("شناسه‌ی اینستاگرام", input("instagram_id", c.instagram_id, 'dir="ltr" placeholder="@namir.cafe"'))}
      ${field("نشانی صفحه‌ی اینستاگرام", input("instagram_url", c.instagram_url, 'dir="ltr" placeholder="https://instagram.com/namir.cafe"'))}
      ${field("ایمیل", input("email", c.email, 'type="email" dir="ltr"'))}
    </div>
    ${field("نشانی کافه", textarea("address", c.address, 2))}
    ${field("سایر اطلاعات تماس", textarea("extra", c.extra, 2))}
    <h3>ساعات کاری</h3>
    <div class="hours-ed">
      ${days.map((d, i) => `<div class="hrow" data-i="${i}"><b>${esc(d.day)}</b>
        <input type="time" name="o${i}" value="${esc(d.open)}" ${d.closed ? "disabled" : ""} aria-label="ساعت شروع ${esc(d.day)}">
        <span>تا</span>
        <input type="time" name="c${i}" value="${esc(d.close)}" ${d.closed ? "disabled" : ""} aria-label="ساعت پایان ${esc(d.day)}">
        ${sw("x" + i, d.closed, "تعطیل")}</div>`).join("")}
    </div>
    <button type="button" class="btn btn--ghost btn--sm" id="applyAll">اعمال ساعت شنبه برای همه‌ی روزها</button>
    <div class="actions"><button class="btn btn--primary" type="submit">ذخیره‌ی تغییرات</button></div></form>`;
  const f = $("#f");
  f.addEventListener("change", (e) => { const m = /^x(\d)$/.exec(e.target.name || ""); if (m) { f["o" + m[1]].disabled = f["c" + m[1]].disabled = e.target.checked; } });
  $("#applyAll").addEventListener("click", () => days.forEach((_, i) => { f["o" + i].value = f.o0.value; f["c" + i].value = f.c0.value; }));
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const d = formData(f), btn = f.querySelector("[type=submit]");
    const mobile = toEn(d.mobile).replace(/\s/g, ""), landline = toEn(d.landline).replace(/\s/g, "");
    if (mobile && !/^\+?\d{7,15}$/.test(mobile)) return toast("شماره‌ی همراه معتبر نیست.", true);
    if (landline && !/^\+?\d{5,15}$/.test(landline)) return toast("شماره‌ی تلفن ثابت معتبر نیست.", true);
    if (d.instagram_url && !/^https?:\/\//i.test(d.instagram_url.trim())) return toast("نشانی اینستاگرام باید با https:// شروع شود.", true);
    const hrs = days.map((x, i) => ({ day: x.day, open: d["o" + i] || x.open, close: d["c" + i] || x.close, closed: f["x" + i].checked }));
    if (hrs.some((h) => !h.closed && (!h.open || !h.close))) return toast("ساعت شروع و پایان را کامل وارد کنید.", true);
    busy(btn, true);
    const ok1 = await saveSetting("contact", { mobile, landline, address: d.address.trim(), instagram_id: d.instagram_id.trim(), instagram_url: d.instagram_url.trim(), email: d.email.trim(), extra: d.extra.trim() });
    const ok2 = ok1 && await saveSetting("hours", { days: hrs });
    busy(btn, false);
  });
}

// ---------------------------------------------------------------
// TAB 6 — Animation settings
// ---------------------------------------------------------------
function tabAnimation(body) {
  const a = state.settings.animation, logo = imageField("لوگوی انیمیشن آغازین (اگر خالی باشد لوگوی اصلی استفاده می‌شود)", a.intro_logo_url, "ilogo");
  const sel = (name, val, opts) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  body.innerHTML = `<form class="panel" id="f" novalidate>
    ${sw("intro_enabled", a.intro_enabled, "نمایش انیمیشن آغازین هنگام ورود بازدیدکننده")}
    ${sw("intro_once_per_session", a.intro_once_per_session, "فقط یک‌بار در هر نشست مرورگر نمایش داده شود")}
    ${logo.html}
    <div class="grid2">
      ${field("حالت انیمیشن لوگو", sel("intro_style", a.intro_style, [["fade-scale", "ظاهر شدن با بزرگ‌نمایی"], ["fade-up", "ظاهر شدن از پایین"], ["blur-in", "محو به واضح"], ["draw", "ترسیم خطی (برای لوگوی پیش‌فرض)"]]))}
      ${field(`مدت انیمیشن: <b id="dv">${toFa((a.intro_duration_ms / 1000).toFixed(1))}</b> ثانیه`, `<input type="range" name="intro_duration_ms" min="1000" max="8000" step="200" value="${a.intro_duration_ms}">`)}
    </div>
    ${field("رنگ پس‌زمینه‌ی انیمیشن (حالت روشن)", `<div class="color"><div><input type="color" data-ibg value="${a.intro_bg || "#F5F0E5"}"><input name="intro_bg" value="${a.intro_bg || "#F5F0E5"}" dir="ltr" maxlength="7"></div></div>`)}
    <h3>سایر انیمیشن‌های وب‌سایت</h3>
    ${sw("page_animations", a.page_animations !== false, "انیمیشن‌های صفحه فعال باشد (خاموش = بدون حرکت)")}
    <div class="grid2">
      ${field("انیمیشن ظاهر شدن کارت‌ها", sel("card_animation", a.card_animation, [["rise", "بالا آمدن نرم"], ["fade", "محو شدن"], ["none", "بدون انیمیشن"]]))}
      ${field("انیمیشن پنجره‌ی جزئیات محصول", sel("popup_animation", a.popup_animation, [["pop", "بزرگ‌نمایی"], ["slide", "لغزش از پایین"], ["fade", "محو شدن"]]))}
    </div>
    <div class="actions"><button class="btn btn--primary" type="submit">ذخیره‌ی تغییرات</button><button class="btn btn--ghost" type="button" id="prev">پیش‌نمایش انیمیشن ذخیره‌شده</button></div></form>`;
  const f = $("#f"), ctl = logo.bind(body);
  f.intro_duration_ms.addEventListener("input", () => ($("#dv").textContent = toFa((f.intro_duration_ms.value / 1000).toFixed(1))));
  $("[data-ibg]", f).addEventListener("input", (e) => (f.intro_bg.value = e.target.value));
  f.intro_bg.addEventListener("input", () => { if (/^#[0-9a-f]{6}$/i.test(f.intro_bg.value)) $("[data-ibg]", f).value = f.intro_bg.value; });
  $("#prev").addEventListener("click", async () => { const m = await import("./app.js"); m.replayIntro(); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const d = formData(f), btn = f.querySelector("[type=submit]");
    if (!/^#[0-9a-f]{6}$/i.test(d.intro_bg)) return toast("رنگ پس‌زمینه نامعتبر است.", true);
    busy(btn, true);
    try {
      const intro_logo_url = await ctl.resolve("intro");
      await saveSetting("animation", { intro_enabled: f.intro_enabled.checked, intro_once_per_session: f.intro_once_per_session.checked, intro_logo_url, intro_style: d.intro_style,
        intro_duration_ms: Number(d.intro_duration_ms), intro_bg: d.intro_bg, page_animations: f.page_animations.checked, card_animation: d.card_animation, popup_animation: d.popup_animation }, btn) && go("animation");
    } catch (ex) { fail(ex, "آپلود لوگو"); }
    busy(btn, false);
  });
}

// ---------------------------------------------------------------
// TAB 7 — Login history
// ---------------------------------------------------------------
async function tabLogins(body) {
  body.innerHTML = `<div class="toolbar"><button class="btn btn--ghost btn--sm" id="rf">↻ تازه‌سازی</button><span class="muted" id="cnt"></span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>تاریخ</th><th>ساعت</th><th>وضعیت</th><th>نام کاربری</th><th>مرورگر</th><th>دستگاه</th><th>سیستم‌عامل</th><th>IP</th><th>جزئیات</th></tr></thead><tbody id="lb"></tbody></table></div>
    <div class="center"><button class="btn btn--ghost btn--sm" id="more" hidden>نمایش بیشتر</button></div>`;
  const PAGE = 50; let offset = 0;
  const lb = $("#lb");
  const load = async (reset) => {
    if (reset) { offset = 0; lb.innerHTML = `<tr><td colspan="10" class="center muted">در حال بارگذاری…</td></tr>`; }
    const { data, error, count } = await sb.from("login_history").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + PAGE - 1);
    if (error) { lb.innerHTML = `<tr><td colspan="10" class="center">خطا در دریافت تاریخچه</td></tr>`; return fail(error, "دریافت تاریخچه"); }
    if (reset) lb.innerHTML = "";
    const det = (r) => { const x = r.details || {}; return [x.screen, x.language, x.timezone, x.platform].filter(Boolean).join(" · ") + (x.reason && x.reason !== "ok" ? ` · ${x.reason === "invalid_credentials" ? "اطلاعات نادرست" : x.reason === "rate_limited" ? "محدودیت تلاش" : x.reason}` : ""); };
    lb.insertAdjacentHTML("beforeend", (data || []).map((r, i) => `<tr class="${r.success ? "" : "bad"}"><td>${toFa(offset + i + 1)}</td><td>${jalaliDate(r.created_at)}</td><td dir="ltr">${jalaliTime(r.created_at)}</td>
      <td><span class="badge ${r.success ? "ok" : "no"}">${r.success ? "موفق" : "ناموفق"}</span></td><td dir="ltr">${esc(r.username || "—")}</td><td>${esc(r.browser || "—")}</td><td>${esc(r.device_type || "—")}</td><td>${esc(r.os || "—")}</td><td dir="ltr">${esc(r.ip || "—")}</td><td class="det" title="${esc(r.user_agent || "")}">${esc(det(r))}</td></tr>`).join(""));
    if (reset && !(data || []).length) lb.innerHTML = `<tr><td colspan="10" class="center muted">هنوز ورودی ثبت نشده است.</td></tr>`;
    offset += (data || []).length;
    $("#cnt").textContent = `${toFa(count ?? offset)} رکورد`;
    $("#more").hidden = offset >= (count ?? 0);
  };
  $("#rf").addEventListener("click", () => load(true));
  $("#more").addEventListener("click", () => load(false));
  load(true);
}
