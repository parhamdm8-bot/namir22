const FA = "۰۱۲۳۴۵۶۷۸۹";
export const toFa = (v) => String(v ?? "").replace(/\d/g, (d) => FA[d]);
/** Persian/Arabic digits → ASCII digits */
export const toEn = (v) => String(v ?? "")
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
  .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[٬,،]/g, "");
export const fmtPrice = (n) => toFa(Number(n || 0).toLocaleString("en-US").replace(/,/g, "٬"));
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Normalise Persian text for searching (ي→ی, ك→ک, strip ZWNJ/diacritics, digits, case) */
export const norm = (s) => toEn(s).toLowerCase()
  .replace(/[يى]/g, "ی").replace(/[كک]/g, "ک").replace(/ۀ|ة/g, "ه")
  .replace(/[ً-ٰٟ‌‍‎‏]/g, "")
  .replace(/\s+/g, " ").trim();

export const FALLBACK_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'>` +
  `<g fill='none' stroke='#B68B68' stroke-width='5' stroke-linecap='round' stroke-linejoin='round' opacity='.75'>` +
  `<path d='M150 130h100v42a38 38 0 0 1-38 38h-24a38 38 0 0 1-38-38z'/><path d='M250 140h10a19 19 0 0 1 0 38h-10'/>` +
  `<path d='M135 226h130'/><path d='M180 112c-9-11 9-16 0-30M212 112c-9-11 9-16 0-30' stroke='#70C5BB'/></g></svg>`);

export const discountPercent = (p) =>
  p.discount_active && p.discount_price != null && p.price > 0 && p.discount_price < p.price
    ? Math.round((1 - p.discount_price / p.price) * 100) : 0;
export const hasDiscount = (p) => !!(p.discount_active && p.discount_price != null && p.discount_price < p.price);

export function toast(msg, isErr = false) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.setAttribute("role", isErr ? "alert" : "status");
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 320); }, isErr ? 4500 : 2600);
}

export const jalaliDate = (iso) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
export const jalaliTime = (iso) => new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso));

/** Only allow safe URL protocols for links coming from the database */
export const safeUrl = (u, fallback = "#") => {
  try { const x = new URL(u, location.href); return ["http:", "https:"].includes(x.protocol) ? x.href : fallback; } catch { return fallback; }
};

/** Scroll lock without layout shift: compensate the scrollbar width manually. */
let locks = 0;
export function lockScroll() {
  const r = document.documentElement;
  if (locks++ === 0) { r.style.setProperty("--sbw", (window.innerWidth - r.clientWidth) + "px"); r.classList.add("lock"); }
}
export function unlockScroll() {
  const r = document.documentElement;
  if (locks > 0 && --locks === 0) { r.classList.remove("lock"); r.style.removeProperty("--sbw"); }
}
