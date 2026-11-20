import { isConfigured, libFailed } from "./supabase-client.js";
import { state, onChange, loadAll, subscribeRealtime } from "./store.js";
import { esc, toFa, toEn, fmtPrice, norm, FALLBACK_IMG, discountPercent, hasDiscount, safeUrl, lockScroll, unlockScroll } from "./utils.js";

const $ = (s, r = document) => r.querySelector(s);
const root = document.documentElement;

// ---------------------------------------------------------------
// Theme (visitor preference only; site content always comes from DB)
// ---------------------------------------------------------------
function setTheme(t, persist = true) {
  root.classList.add("theme-fade");
  root.setAttribute("data-theme", t);
  if (persist) { try { localStorage.setItem("namir_theme", t); } catch { /* private mode */ } }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#1C1E1B" : (state.settings.brand.colors.bg || "#F5F0E5"));
  setTimeout(() => root.classList.remove("theme-fade"), 450);
}
$("#themeBtn").addEventListener("click", () => setTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark"));

// ---------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------
const loadedFonts = new Set(["Vazirmatn"]);
function ensureFont(name) {
  if (!name || loadedFonts.has(name)) return;
  loadedFonts.add(name);
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@400;500;700;800&display=swap`;
  document.head.appendChild(l);
}

// ---------------------------------------------------------------
// Brand / contact / about / hours rendering (all from DB)
// ---------------------------------------------------------------
function applyBrand() {
  const b = state.settings.brand, c = b.colors || {};
  const ok = (v) => v && /^#[0-9a-f]{3,8}$/i.test(v);
  // Brand colours shared by both themes (set inline)…
  if (ok(c.primary)) root.style.setProperty("--primary", c.primary);
  if (ok(c.accent)) root.style.setProperty("--accent", c.accent);
  if (ok(c.button)) root.style.setProperty("--btn", c.button);
  // …while the light palette is injected under the light selector so the dark palette is never overridden.
  const lightVars = { "--bg": c.bg, "--text": c.text, "--mint": c.mint, "--wood": c.wood, "--discount": c.discount, "--btn-text": c.button_text };
  const lightCss = ":root[data-theme='light']{" + Object.entries(lightVars).filter(([, v]) => ok(v)).map(([k, v]) => `${k}:${v}`).join(";") + "}";
  let el = $("#brandStyle"); if (!el) { el = document.createElement("style"); el.id = "brandStyle"; document.head.appendChild(el); }
  el.textContent = lightCss;
  ensureFont(b.font); ensureFont(b.heading_font);
  root.style.setProperty("--font-body", `"${b.font || "Vazirmatn"}", "Vazirmatn", system-ui, Tahoma, sans-serif`);
  root.style.setProperty("--font-head", `"${b.heading_font || b.font || "Vazirmatn"}", "Vazirmatn", system-ui, Tahoma, sans-serif`);
  root.style.setProperty("--fs", `${Math.min(22, Math.max(13, Number(b.base_font_size) || 16))}px`);

  $("#brandName").textContent = b.name;
  $("#heroTitle").textContent = b.name;
  $("#heroEn").textContent = b.name_en || "";
  $("#heroEn").hidden = !b.name_en;
  $("#heroTag").textContent = b.tagline || "";
  $("#heroTag").hidden = !b.tagline;
  document.title = b.name + (b.tagline ? " — " + b.tagline : "");
  $("#heroMark").innerHTML = b.logo_url
    ? `<img src="${esc(safeUrl(b.logo_url))}" alt="${esc(b.name)}" width="92" height="92">`
    : `<svg role="img" aria-label="${esc(b.name)}"><use href="#logo-cup"/></svg>`;
  $("#heroMark").querySelectorAll(".draw").forEach((p) => (p.style.strokeDashoffset = 0));
  if (b.logo_url) {
    let ic = document.querySelector('link[rel="icon"]'); if (ic) ic.href = safeUrl(b.logo_url);
  }
}

function applyAnimSettings() {
  const a = state.settings.animation;
  root.classList.toggle("no-anim", a.page_animations === false);
  $("#modal").dataset.anim = a.popup_animation || "pop";
}

function applyContact() {
  const c = state.settings.contact;
  const phone = $("#navPhone"), insta = $("#navInsta");
  phone.hidden = !c.mobile;
  phone.href = "tel:" + toEn(c.mobile).replace(/[^\d+]/g, "");
  $("#navPhoneTxt").textContent = toFa(c.mobile);
  insta.hidden = !c.instagram_id && !c.instagram_url;
  insta.href = safeUrl(c.instagram_url || `https://instagram.com/${String(c.instagram_id).replace(/^@/, "")}`);
  $("#navInstaTxt").textContent = c.instagram_id;

  const li = (icon, html) => `<li><svg class="ico"><use href="#${icon}"/></svg><div>${html}</div></li>`;
  const tel = (n) => `<a href="tel:${esc(toEn(n).replace(/[^\d+]/g, ""))}" dir="ltr">${esc(toFa(n))}</a>`;
  const rows = [];
  if (c.landline) rows.push(li("i-phone", `<small>تلفن ثابت</small>${tel(c.landline)}`));
  if (c.mobile) rows.push(li("i-phone", `<small>تلفن همراه</small>${tel(c.mobile)}`));
  if (c.address) rows.push(li("i-pin", `<small>نشانی</small>${esc(c.address)}`));
  if (c.instagram_id || c.instagram_url) rows.push(li("i-insta", `<small>اینستاگرام</small><a href="${esc(safeUrl(c.instagram_url || `https://instagram.com/${String(c.instagram_id).replace(/^@/, "")}`))}" target="_blank" rel="noopener noreferrer" dir="ltr">${esc(c.instagram_id || c.instagram_url)}</a>`));
  if (c.email) rows.push(li("i-mail", `<small>ایمیل</small><a href="mailto:${esc(c.email)}" dir="ltr">${esc(c.email)}</a>`));
  if (c.extra) rows.push(li("i-pin", `${esc(c.extra).replace(/\n/g, "<br>")}`));
  $("#infoList").innerHTML = rows.join("");
}

function applyAbout() {
  const a = state.settings.about;
  $("#aboutTitle").textContent = a.title || "درباره‌ی ما";
  for (const [id, key] of [["aboutIntro", "intro"], ["aboutDesc", "description"], ["aboutExtra", "extra"]]) {
    const el = $("#" + id); el.textContent = a[key] || ""; el.hidden = !a[key];
    el.style.whiteSpace = "pre-line";
  }
}

function applyHours() {
  const days = (state.settings.hours.days || []);
  const box = $("#hoursBox");
  if (!days.length) { box.innerHTML = ""; return; }
  const t = (x) => toFa(x);
  const open = days.filter((d) => !d.closed);
  const allSame = open.length === days.length && days.every((d) => d.open === days[0].open && d.close === days[0].close);
  if (allSame) {
    box.innerHTML = `<div class="hours__main"><svg class="ico"><use href="#i-clock"/></svg><span>${esc(days[0].day)} تا ${esc(days[days.length - 1].day)}</span></div>
      <div class="hours__row"><span>ساعت کاری</span><span dir="ltr">${t(days[0].open)} – ${t(days[0].close)}</span></div>`;
  } else {
    box.innerHTML = days.map((d) => `<div class="hours__row ${d.closed ? "closed" : ""}"><span>${esc(d.day)}</span><span dir="ltr">${d.closed ? "تعطیل" : `${t(d.open)} – ${t(d.close)}`}</span></div>`).join("");
  }
}

// ---------------------------------------------------------------
// Menu
// ---------------------------------------------------------------
let query = "";
const priceHTML = (p, cls = "") => hasDiscount(p)
  ? `<div class="price price--sale ${cls}"><span class="price__now">${fmtPrice(p.discount_price)} <span class="price__cur">تومان</span></span><span class="price__old">${fmtPrice(p.price)}</span></div>`
  : `<div class="price ${cls}"><span class="price__now">${fmtPrice(p.price)} <span class="price__cur">تومان</span></span></div>`;

function visibleData() {
  const cats = state.categories.filter((c) => c.visible !== false).sort((a, b) => a.sort_order - b.sort_order);
  const catIds = new Set(cats.map((c) => c.id));
  const prods = state.products.filter((p) => p.visible !== false && catIds.has(p.category_id)).sort((a, b) => a.sort_order - b.sort_order);
  return { cats, prods };
}

let io;
function observeReveals() {
  const anim = state.settings.animation.card_animation;
  const cls = anim === "fade" ? "reveal-fade" : anim === "none" ? null : "reveal-rise";
  const nodes = [...document.querySelectorAll("#menu .card")];
  if (!cls || state.settings.animation.page_animations === false || !("IntersectionObserver" in window)) return;
  io?.disconnect();
  io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
  nodes.forEach((n, i) => { n.classList.add(cls); n.style.transitionDelay = (i % 6) * 40 + "ms"; io.observe(n); });
}

function renderMenu() {
  const { cats, prods } = visibleData();
  const q = norm(query);
  const list = q ? prods.filter((p) => norm(p.name).includes(q)) : prods;
  const byCat = new Map(cats.map((c) => [c.id, []]));
  list.forEach((p) => byCat.get(p.category_id)?.push(p));
  const shown = cats.filter((c) => byCat.get(c.id).length);

  $("#menu").innerHTML = shown.map((c) => `
    <section class="cat" id="cat-${esc(c.id)}" aria-labelledby="ct-${esc(c.id)}">
      <div class="cat__head">
        ${c.image_url ? `<img class="cat__icon" src="${esc(safeUrl(c.image_url))}" alt="" width="46" height="46" loading="lazy" decoding="async">` : ""}
        <h2 class="cat__title" id="ct-${esc(c.id)}">${esc(c.name)}</h2>
        <span class="cat__count">${toFa(byCat.get(c.id).length)} مورد</span>
      </div>
      <div class="grid">
        ${byCat.get(c.id).map((p) => {
          const sale = hasDiscount(p);
          return `<button type="button" class="card ${sale ? "card--sale" : ""}" data-id="${esc(p.id)}" aria-label="${esc(p.name)}">
            ${sale ? `<span class="ribbon">${toFa(discountPercent(p))}٪ تخفیف</span>` : ""}
            <span class="card__img"><img src="${esc(p.image_url ? safeUrl(p.image_url) : FALLBACK_IMG)}" alt="${esc(p.name)}" width="400" height="300" loading="lazy" decoding="async"></span>
            <span class="card__body"><span class="card__name">${esc(p.name)}</span>${priceHTML(p, "card__price")}</span>
          </button>`;
        }).join("")}
      </div>
    </section>`).join("");

  $("#chips").innerHTML = shown.map((c) => `<button type="button" class="chip" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join("");
  $("#noResults").hidden = !(q && !list.length) && !(!q && !prods.length);
  if (!q && !prods.length) $("#noResults p").textContent = "هنوز محصولی در منو ثبت نشده است.";
  else $("#noResults p").textContent = "محصولی با این نام پیدا نشد.";
  $("#noResultsClear").hidden = !q;
  $("#searchClear").hidden = !query;
  observeReveals();
}

// image fallback (error events don't bubble → capture)
document.addEventListener("error", (e) => {
  const t = e.target;
  if (t.tagName === "IMG" && !t.dataset.fb && (t.closest("#menu") || t.closest("#modal"))) { t.dataset.fb = 1; t.src = FALLBACK_IMG; }
}, true);

$("#search").addEventListener("input", (e) => { query = e.target.value; renderMenu(); });
const clearSearch = () => { query = ""; $("#search").value = ""; renderMenu(); $("#search").focus({ preventScroll: true }); };
$("#searchClear").addEventListener("click", clearSearch);
$("#noResultsClear").addEventListener("click", clearSearch);

$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  document.getElementById("cat-" + b.dataset.cat)?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#menu").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openProduct(c.dataset.id, c); });

// ---------------------------------------------------------------
// Product popup
// ---------------------------------------------------------------
const modal = $("#modal");
let openId = null, lastFocus = null;

function fillModal(p) {
  const sale = hasDiscount(p);
  const img = $("#mImg");
  img.dataset.fb = ""; img.src = p.image_url ? safeUrl(p.image_url) : FALLBACK_IMG; img.alt = p.name;
  $("#mName").textContent = p.name;
  $("#mPrice").className = "price" + (sale ? " price--sale" : "");
  $("#mPrice").innerHTML = priceHTML(p).replace(/^<div[^>]*>|<\/div>$/g, "");
  const badge = $("#mBadge"); badge.hidden = !sale; badge.textContent = sale ? `${toFa(discountPercent(p))}٪ تخفیف` : "";
  const reason = $("#mReason"); reason.hidden = !(sale && p.discount_reason); reason.textContent = p.discount_reason ? "🏷️ " + p.discount_reason : "";
  const d = $("#mDesc"); d.hidden = !p.description; d.textContent = p.description || ""; d.style.whiteSpace = "pre-line";
  const ing = (p.ingredients || "").split(/[,،\n]+/).map((s) => s.trim()).filter(Boolean);
  $("#mIngBox").hidden = !ing.length;
  $("#mIng").innerHTML = ing.map((i) => `<li>${esc(i)}</li>`).join("");
}
function openProduct(id, trigger) {
  const p = state.products.find((x) => x.id === id); if (!p) return;
  openId = id; lastFocus = trigger || document.activeElement;
  fillModal(p);
  modal.querySelector(".modal__body").scrollTop = 0;
  lockScroll();
  modal.classList.add("open"); modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => modal.querySelector(".modal__card").focus({ preventScroll: true }));
}
function closeModal() {
  if (!modal.classList.contains("open")) return;
  modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true");
  unlockScroll(); openId = null;
  lastFocus?.focus?.({ preventScroll: true });
}
modal.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
export { closeModal };

// ---------------------------------------------------------------
// Scroll helpers
// ---------------------------------------------------------------
$("#aboutBtn").addEventListener("click", () => document.getElementById("about").scrollIntoView({ behavior: "smooth", block: "start" }));
const toTop = $("#toTop");
let ticking = false;
const onScroll = () => { if (ticking) return; ticking = true; requestAnimationFrame(() => { toTop.classList.toggle("show", window.scrollY > 420); ticking = false; }); };
window.addEventListener("scroll", onScroll, { passive: true });
toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

// ---------------------------------------------------------------
// Admin entry (hidden): only the brand name in the nav opens it
// ---------------------------------------------------------------
let adminMod = null;
$("#brandBtn").addEventListener("click", async () => {
  try { adminMod ||= await import("./admin.js"); adminMod.openAdmin(); }
  catch (e) { console.error(e); import("./utils.js").then((u) => u.toast("بارگذاری پنل مدیریت ممکن نشد. اتصال اینترنت را بررسی کنید.", true)); }
});

// ---------------------------------------------------------------
// Intro animation
// ---------------------------------------------------------------
function revealSite() { document.body.classList.remove("is-loading"); }
function playIntro(force = false) {
  return new Promise((resolve) => {
    const a = state.settings.animation, b = state.settings.brand, el = $("#intro");
    let seen = false; try { seen = sessionStorage.getItem("namir_intro") === "1"; } catch { /* noop */ }
    if (!force && (!a.intro_enabled || (a.intro_once_per_session && seen))) { el.classList.add("gone"); return resolve(); }
    const D = Math.min(10000, Math.max(1000, Number(a.intro_duration_ms) || 3200));
    const logo = a.intro_logo_url || b.logo_url;
    el.style.setProperty("--d", D + "ms");
    el.style.setProperty("--intro-bg", a.intro_bg && root.getAttribute("data-theme") !== "dark" ? a.intro_bg : "");
    el.dataset.style = a.intro_style || "fade-scale";
    el.classList.remove("gone", "out");
    $("#introStage").innerHTML = `<div class="intro__logo">${logo ? `<img src="${esc(safeUrl(logo))}" alt="">` : `<svg><use href="#logo-cup"/></svg>`}</div>
      <div class="intro__name">${esc(b.name)}</div>${b.name_en ? `<div class="intro__en" dir="ltr">${esc(b.name_en)}</div>` : ""}`;
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-loading");
    lockScroll();
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      el.classList.add("out");
      revealSite();
      setTimeout(() => { el.classList.add("gone"); el.setAttribute("aria-hidden", "true"); unlockScroll(); resolve(); }, D * 0.28 + 60);
    };
    $("#introSkip").onclick = finish;
    setTimeout(finish, D * 0.72);
    try { sessionStorage.setItem("namir_intro", "1"); } catch { /* noop */ }
  });
}
export const replayIntro = () => playIntro(true).then(() => document.body.classList.remove("is-loading"));

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
function showError(title, text) {
  $("#intro").classList.add("gone"); revealSite();
  $("#menuSkeleton").hidden = true;
  const e = $("#siteError"); e.hidden = false;
  e.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p>`;
  $("#site").style.display = "none";
}

let booted = false;
function renderAll(what) {
  if (what === "settings") { applyBrand(); applyAnimSettings(); applyContact(); applyAbout(); applyHours(); }
  if (what === "settings" && !booted) return;
  if (what === "categories" || what === "products" || what === "settings") {
    renderMenu();
    if (openId) { const p = state.products.find((x) => x.id === openId); p && modal.classList.contains("open") ? fillModal(p) : closeModal(); }
  }
}

async function boot() {
  if (!isConfigured) {
    return showError("اتصال به پایگاه‌داده برقرار نیست", "این وب‌سایت هنوز به Supabase متصل نشده است. فایل public/js/config.js را طبق راهنمای README تکمیل کنید.");
  }
  if (libFailed) return showError("بارگذاری ناموفق بود", "اتصال اینترنت را بررسی کنید و صفحه را دوباره باز کنید.");
  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    return showError("خطا در بارگذاری اطلاعات", "ارتباط با سرور برقرار نشد. لطفاً اتصال اینترنت را بررسی و صفحه را دوباره باز کنید.");
  }
  setTheme(root.getAttribute("data-theme"), false);
  applyBrand(); applyAnimSettings(); applyContact(); applyAbout(); applyHours(); renderMenu();
  booted = true;
  onChange(renderAll);
  subscribeRealtime();
  await playIntro();
  revealSite();
}
boot();
