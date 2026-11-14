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

-- やることに起きたこと（追加・期限の変更・完了・削除）の記録。報告は、これを時間で区切って読む。
-- 記録はデータベースが自動でつけるので、どの端末から操作しても漏れない。
create table if not exists public.item_events (
  id       bigint generated always as identity primary key,
  user_id  uuid not null,
  item_id  uuid not null,
  kind     text not null check (kind in ('added', 'due_changed', 'done', 'reopened', 'deleted')),
  content  text not null,                      -- そのときの「内容」
  old_due  date,
  new_due  date,
  at       timestamptz not null default now()
);
create index if not exists item_events_user_at on public.item_events (user_id, at);

alter table public.item_events enable row level security;

drop policy if exists "自分の記録を読むだけ" on public.item_events;
create policy "自分の記録を読むだけ" on public.item_events
  for select to authenticated
  using (auth.uid() = user_id);

grant select on public.item_events to authenticated;

create or replace function public.log_item_event() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op = 'INSERT' then
    insert into item_events (user_id, item_id, kind, content, new_due)
      values (new.user_id, new.id, 'added', new.content, new.due);
  elsif tg_op = 'DELETE' then
    insert into item_events (user_id, item_id, kind, content, old_due)
      values (old.user_id, old.id, 'deleted', old.content, old.due);
  else
    if new.due is distinct from old.due then
      insert into item_events (user_id, item_id, kind, content, old_due, new_due)
        values (new.user_id, new.id, 'due_changed', new.content, old.due, new.due);
    end if;
    if new.status is distinct from old.status then
      insert into item_events (user_id, item_id, kind, content, new_due)
        values (new.user_id, new.id, case when new.status = 'done' then 'done' else 'reopened' end, new.content, new.due);
    end if;
  end if;
  return null;
end;
$fn$;

drop trigger if exists items_log_event on public.items;
create trigger items_log_event
  after insert or update or delete on public.items
  for each row execute function public.log_item_event();

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
