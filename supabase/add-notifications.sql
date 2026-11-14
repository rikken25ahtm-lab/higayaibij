-- ひがやいびん：朝10時・夕方17時の通知に使うテーブルと、時刻の予約
-- Supabase の「SQL Editor」に貼り付けて、Run を1回押してください。
-- （先に Edge Function「report」を作っておくこと。手順は README にあります）

-- 通知を受け取る端末の登録。ログインした本人の分だけ、読み書きできる
create table if not exists public.push_subscriptions (
  endpoint   text primary key,                                              -- 端末ごとの送り先
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh     text not null,                                                 -- 暗号化に使う端末の公開鍵
  auth       text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "自分の端末だけ" on public.push_subscriptions;
create policy "自分の端末だけ" on public.push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- 通知の署名に使う鍵（Edge Function が初回に自動で作る）と、送った回の記録。
-- 行レベルセキュリティを有効にして許可を1つも作らないので、ページ側からは読めない。
create table if not exists public.push_config (
  key   text primary key,
  value jsonb not null
);
alter table public.push_config enable row level security;

create table if not exists public.report_log (
  slot    text primary key,                        -- 例：2026-11-15-morning
  sent_at timestamptz not null default now()
);
alter table public.report_log enable row level security;

-- 毎日 10:00 と 17:00（日本時間）に Edge Function を呼ぶ。
-- cron の時刻は世界標準時なので、9時間引いた 1:00 と 8:00 を指定している。
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('higayaibin-morning', '0 1 * * *', $$
  select net.http_post(
    url := 'https://ngddtyyxfcmfzpjqcaco.supabase.co/functions/v1/report',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

select cron.schedule('higayaibin-evening', '0 8 * * *', $$
  select net.http_post(
    url := 'https://ngddtyyxfcmfzpjqcaco.supabase.co/functions/v1/report',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
