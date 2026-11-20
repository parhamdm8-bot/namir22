-- =====================================================================
-- NAMIR CAFE — Supabase schema
-- Run this whole file once in: Supabase Dashboard → SQL Editor → New query
-- =====================================================================

-- ---------- Tables ----------------------------------------------------

create table if not exists public.site_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  image_url   text,
  sort_order  integer not null default 0,
  visible     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.products (
  id              uuid primary key default gen_random_uuid(),
  category_id     uuid references public.categories(id) on delete set null,
  name            text not null,
  description     text default '',
  ingredients     text default '',
  image_url       text,
  price           bigint not null default 0 check (price >= 0),
  discount_active boolean not null default false,
  discount_price  bigint check (discount_price is null or discount_price >= 0),
  discount_reason text default '',
  sort_order      integer not null default 0,
  visible         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category_id, sort_order);

create table if not exists public.login_history (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  username    text,
  success     boolean not null,
  ip          text,
  user_agent  text,
  browser     text,
  os          text,
  device_type text,
  details     jsonb not null default '{}'::jsonb
);
create index if not exists login_history_created_idx on public.login_history(created_at desc);

-- keep updated_at fresh
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
for each row execute function public.touch_updated_at();

drop trigger if exists settings_touch on public.site_settings;
create trigger settings_touch before update on public.site_settings
for each row execute function public.touch_updated_at();

-- ---------- Row Level Security ---------------------------------------
-- Public (anon) : read-only, and only visible rows.
-- Admin (authenticated, the single Manager account) : full access.
-- Sign-ups are disabled in Supabase Auth, so "authenticated" == Manager.

alter table public.site_settings  enable row level security;
alter table public.categories     enable row level security;
alter table public.products       enable row level security;
alter table public.login_history  enable row level security;

-- site_settings
drop policy if exists "settings public read"  on public.site_settings;
drop policy if exists "settings admin write"  on public.site_settings;
create policy "settings public read" on public.site_settings for select to anon, authenticated using (true);
create policy "settings admin write" on public.site_settings for all    to authenticated using (true) with check (true);

-- categories
drop policy if exists "categories public read" on public.categories;
drop policy if exists "categories admin all"   on public.categories;
create policy "categories public read" on public.categories for select to anon using (visible = true);
create policy "categories admin all"   on public.categories for all    to authenticated using (true) with check (true);

-- products
drop policy if exists "products public read" on public.products;
drop policy if exists "products admin all"   on public.products;
create policy "products public read" on public.products for select to anon using (visible = true);
create policy "products admin all"   on public.products for all    to authenticated using (true) with check (true);

-- login_history: admin can only READ. Rows are inserted by the Edge Function
-- (service role bypasses RLS). Nobody else can read or write.
drop policy if exists "login_history admin read" on public.login_history;
create policy "login_history admin read" on public.login_history for select to authenticated using (true);

-- ---------- Realtime --------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.site_settings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.categories;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.products;      exception when duplicate_object then null; end;
end $$;

-- ---------- Storage (product images, logo, category images) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('namir-assets', 'namir-assets', true, 5242880,
        array['image/jpeg','image/png','image/webp','image/gif','image/svg+xml','image/avif'])
on conflict (id) do update set public = true, file_size_limit = 5242880;

drop policy if exists "assets public read"  on storage.objects;
drop policy if exists "assets admin insert" on storage.objects;
drop policy if exists "assets admin update" on storage.objects;
drop policy if exists "assets admin delete" on storage.objects;
create policy "assets public read"  on storage.objects for select to anon, authenticated using (bucket_id = 'namir-assets');
create policy "assets admin insert" on storage.objects for insert to authenticated with check (bucket_id = 'namir-assets');
create policy "assets admin update" on storage.objects for update to authenticated using (bucket_id = 'namir-assets');
create policy "assets admin delete" on storage.objects for delete to authenticated using (bucket_id = 'namir-assets');

-- ---------- Seed: default settings -----------------------------------
insert into public.site_settings (key, value) values
('brand', '{
  "name": "نمیر کافه",
  "name_en": "NAMIR CAFE",
  "tagline": "روحِ قدیمی، تجربه‌ی امروزی",
  "logo_url": "",
  "font": "Vazirmatn",
  "base_font_size": 16,
  "colors": {
    "primary": "#70C5BB",
    "bg": "#F5F0E5",
    "accent": "#E9A36B",
    "text": "#292B28",
    "mint": "#D9EAE3",
    "wood": "#B68B68",
    "button": "#70C5BB",
    "button_text": "#292B28",
    "discount": "#C0553A"
  }
}'),
('about', '{
  "title": "درباره‌ی ما",
  "intro": "نمیر کافه، گوشه‌ای گرم و نوستالژیک برای دوست‌داران قهوه و گفتگوهای آرام.",
  "description": "ما باور داریم یک فنجان قهوه‌ی خوب می‌تواند روزتان را بسازد. دانه‌های برشته‌شده‌ی تازه، دست‌های با‌حوصله و فضایی که شما را به یاد روزهای قدیمی می‌اندازد؛ این‌جا نمیر است.",
  "extra": ""
}'),
('contact', '{
  "mobile": "09123456789",
  "landline": "02112345678",
  "address": "تهران، خیابان نمونه، پلاک ۱۲",
  "instagram_id": "@namir.cafe",
  "instagram_url": "https://instagram.com/namir.cafe",
  "email": "",
  "extra": ""
}'),
('hours', '{
  "days": [
    {"day":"شنبه","open":"05:30","close":"23:00","closed":false},
    {"day":"یکشنبه","open":"05:30","close":"23:00","closed":false},
    {"day":"دوشنبه","open":"05:30","close":"23:00","closed":false},
    {"day":"سه‌شنبه","open":"05:30","close":"23:00","closed":false},
    {"day":"چهارشنبه","open":"05:30","close":"23:00","closed":false},
    {"day":"پنجشنبه","open":"05:30","close":"23:00","closed":false},
    {"day":"جمعه","open":"05:30","close":"23:00","closed":false}
  ]
}'),
('animation', '{
  "intro_enabled": true,
  "intro_logo_url": "",
  "intro_duration_ms": 3200,
  "intro_style": "fade-scale",
  "intro_once_per_session": true,
  "intro_bg": "#F5F0E5",
  "page_animations": true,
  "card_animation": "rise",
  "popup_animation": "pop"
}')
on conflict (key) do nothing;

-- ---------- Seed: sample categories & products ------------------------
-- (Only runs when the tables are empty. Replace with your real menu in the admin panel.)
do $$
declare c1 uuid; c2 uuid; c3 uuid; c4 uuid;
begin
  if not exists (select 1 from public.categories) then
    insert into public.categories (name, sort_order) values ('قهوه‌های گرم', 1) returning id into c1;
    insert into public.categories (name, sort_order) values ('نوشیدنی‌های سرد', 2) returning id into c2;
    insert into public.categories (name, sort_order) values ('چای و دمنوش', 3) returning id into c3;
    insert into public.categories (name, sort_order) values ('کیک و دسر', 4) returning id into c4;

    insert into public.products (category_id,name,description,ingredients,price,discount_active,discount_price,discount_reason,sort_order) values
    (c1,'اسپرسو','شات غلیظ و خوش‌عطر از دانه‌های برشته‌ی تازه.','دانه‌ی قهوه‌ی عربیکا',75000,false,null,'',1),
    (c1,'لاته','اسپرسو با شیر بخارداده و فوم ابریشمی.','اسپرسو، شیر',120000,true,99000,'تخفیف ویژه‌ی صبحانه',2),
    (c1,'کاپوچینو','تعادل کامل قهوه، شیر و فوم.','اسپرسو، شیر، فوم شیر',125000,false,null,'',3),
    (c2,'آیس لاته','لاته‌ی خنک با یخ، مناسب روزهای گرم.','اسپرسو، شیر، یخ',135000,false,null,'',1),
    (c2,'لیموناد نعنا','لیموناد تازه با برگ نعنا.','لیمو، نعنا، شکر، سودا',110000,false,null,'',2),
    (c3,'چای ماسالا','چای ادویه‌دار با شیر.','چای سیاه، هل، دارچین، زنجبیل، شیر',95000,false,null,'',1),
    (c3,'دمنوش به‌لیمو','دمنوش گرم و آرامش‌بخش.','به‌لیمو، عسل',85000,false,null,'',2),
    (c4,'چیزکیک','چیزکیک خانگی با سس توت‌فرنگی.','پنیر خامه‌ای، بیسکویت، توت‌فرنگی',160000,false,null,'',1),
    (c4,'براونی','براونی شکلاتی گرم.','شکلات تلخ، کره، شکر، گردو',140000,false,null,'',2);
  end if;
end $$;
