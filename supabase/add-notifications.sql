-- ひがやいびん：朝と夕方の報告の通知に使うテーブルと、時刻の予約
-- Supabase の「SQL Editor」に貼り付けて、Run を1回押してください。（何度 Run しても大丈夫です）
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

-- 報告を受け取る時刻（日本時間の「時」）。人ごとに選べる。行がなければ、朝10時・夕方17時。
-- null は、その回を受け取らない
create table if not exists public.notify_settings (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  morning_hour smallint default 10 check (morning_hour between 0 and 23),
  evening_hour smallint default 17 check (evening_hour between 0 and 23),
  updated_at   timestamptz not null default now()
);

alter table public.notify_settings enable row level security;

drop policy if exists "自分の通知の時刻だけ" on public.notify_settings;
create policy "自分の通知の時刻だけ" on public.notify_settings
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.notify_settings to authenticated;

-- 毎時0分に Edge Function を呼ぶ。Edge Function が、その時刻を選んでいる人にだけ報告を送る。
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 以前の予約（朝10時・夕方17時の2つ）があれば消す
select cron.unschedule(jobid) from cron.job where jobname in ('higayaibin-morning', 'higayaibin-evening');

select cron.schedule('higayaibin-hourly', '0 * * * *', $$
  select net.http_post(
    url := 'https://ngddtyyxfcmfzpjqcaco.supabase.co/functions/v1/report',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- 追加した表を、ページからすぐ使えるようにする
notify pgrst, 'reload schema';
