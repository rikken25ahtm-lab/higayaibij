-- ひがやいびん：メールとドライブの連携に使うテーブルと、受け取り口
-- Supabase の「SQL Editor」に貼り付けて、Run を1回押してください。（何度 Run しても大丈夫です）
--
-- 流れ：Gmail の側で動く小さなプログラム（google/mail.gs）が、ラベルのついたメールを見つけ、
-- 添付をドライブに保存してから、ここの受け取り口（receive_mail）に「候補」として届ける。
-- 届いた候補は、ページで本人が確認してから、やることに追加する。

-- メールから作った候補。ログインした本人の分だけ読める
create table if not exists public.mail_candidates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  gmail_id    text not null,                                   -- Gmail のメールごとの番号（同じメールを2度入れないため）
  sender      text not null default '',                        -- 差出人
  subject     text not null default '',                        -- 件名
  excerpt     text not null default '',                        -- 本文の最初の部分
  mail_url    text not null default '',                        -- Gmail でそのメールを開くリンク
  attachments jsonb not null default '[]'::jsonb,              -- ドライブに保存した添付 [{ name, url }]
  received_at timestamptz not null default now(),              -- メールが届いた時刻
  status      text not null default 'new' check (status in ('new', 'added', 'dismissed')),
  item_id     uuid,                                            -- 追加した先の「やること」
  created_at  timestamptz not null default now(),              -- 候補として届いた時刻（報告はこれで区切る）
  unique (user_id, gmail_id)
);
create index if not exists mail_candidates_user_created on public.mail_candidates (user_id, created_at);

-- 緊急かどうか。判定は、届いた直後に通知のプログラム（report）が行う
alter table public.mail_candidates add column if not exists urgent        boolean not null default false;
alter table public.mail_candidates add column if not exists urgent_reason text not null default '';   -- 例：「至急」とある
alter table public.mail_candidates add column if not exists checked_at    timestamptz;                 -- 判定を済ませた時刻

alter table public.mail_candidates enable row level security;

drop policy if exists "自分の候補を読む" on public.mail_candidates;
create policy "自分の候補を読む" on public.mail_candidates
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "自分の候補を片づける" on public.mail_candidates;
create policy "自分の候補を片づける" on public.mail_candidates
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ページから変えられるのは「片づけたかどうか」だけ。中身はメールのまま残す
revoke all on public.mail_candidates from anon, authenticated;
grant select on public.mail_candidates to authenticated;
grant update (status, item_id) on public.mail_candidates to authenticated;

-- 連携の合言葉。合言葉そのものは保存せず、照合用の値（ハッシュ）だけを持つ
create table if not exists public.mail_links (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz                                      -- Gmail の側から最後に確認が来た時刻
);

-- 本人が決める設定：見るラベルの名前と、「大事な相手」（その人からのメールは緊急として通知する）
alter table public.mail_links add column if not exists label     text   not null default 'ひがやいびん' check (char_length(label) between 1 and 40);
alter table public.mail_links add column if not exists important text[] not null default '{}';

alter table public.mail_links enable row level security;

drop policy if exists "自分の連携の状態を読む" on public.mail_links;
create policy "自分の連携の状態を読む" on public.mail_links
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "自分の連携をやめる" on public.mail_links;
create policy "自分の連携をやめる" on public.mail_links
  for delete to authenticated
  using (auth.uid() = user_id);

drop policy if exists "自分の連携の設定を変える" on public.mail_links;
create policy "自分の連携の設定を変える" on public.mail_links
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 照合用の値は、ページからも読めないようにする。ページから変えられるのは、ラベルの名前と大事な相手だけ
revoke all on public.mail_links from anon, authenticated;
grant select (user_id, created_at, last_seen_at, label, important) on public.mail_links to authenticated;
grant update (label, important) on public.mail_links to authenticated;
grant delete on public.mail_links to authenticated;

-- 合言葉を作る（ログイン中の本人だけ）。作り直すと、前の合言葉は使えなくなる。
-- 合言葉が見えるのは、この1回だけ。
create or replace function public.create_mail_token() returns text
language plpgsql security definer set search_path = public as $fn$
declare
  v_user  uuid := auth.uid();
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if v_user is null then
    raise exception 'ログインが必要です' using errcode = '28000';
  end if;
  insert into mail_links (user_id, token_hash)
    values (v_user, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'))
    on conflict (user_id) do update
      set token_hash = excluded.token_hash, created_at = now(), last_seen_at = null;
  return v_token;
end;
$fn$;

-- 合言葉から持ち主を確かめる（確認が来た時刻も記録する）。ほかの関数の中だけで使う
create or replace function public.mail_owner(p_token text) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_user uuid;
begin
  update mail_links set last_seen_at = now()
    where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    returning user_id into v_user;
  if v_user is null then
    raise exception '合言葉が違います' using errcode = '28000';
  end if;
  return v_user;
end;
$fn$;

-- Gmail の側から：本人が決めた設定を読む（どのラベルを見るか）
create or replace function public.mail_settings(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_user uuid := mail_owner(p_token);
begin
  return (select jsonb_build_object('label', label) from mail_links where user_id = v_user);
end;
$fn$;

-- Gmail の側から：このメールの番号のうち、まだ届けていないものはどれか
-- （添付を保存する前に確かめて、同じ添付をドライブに2度保存しないようにする）
create or replace function public.mail_unknown(p_token text, p_ids text[]) returns text[]
language plpgsql security definer set search_path = public as $fn$
declare
  v_user uuid := mail_owner(p_token);
begin
  return coalesce((
    select array_agg(x)
    from unnest(p_ids[1:500]) as x
    where not exists (select 1 from mail_candidates c where c.user_id = v_user and c.gmail_id = x)
  ), '{}');
end;
$fn$;

-- Gmail の側から：候補を届ける。同じメールが2度届いても、1件しか入らない。戻り値は入った件数
create or replace function public.receive_mail(p_token text, p_messages jsonb) returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  v_user  uuid := mail_owner(p_token);
  v_count integer;
begin
  if jsonb_typeof(p_messages) is distinct from 'array' then
    raise exception 'messages は配列で送ってください' using errcode = '22023';
  end if;

  insert into mail_candidates (user_id, gmail_id, sender, subject, excerpt, mail_url, attachments, received_at)
  select
    v_user,
    left(m->>'id', 100),
    left(coalesce(m->>'sender', ''), 200),
    left(coalesce(m->>'subject', ''), 300),
    left(coalesce(m->>'excerpt', ''), 2000),
    case when m->>'mail_url' like 'https://mail.google.com/%' then left(m->>'mail_url', 500) else '' end,
    -- 添付は、Google のリンクだけを最大20件まで受け取る
    coalesce((
      select jsonb_agg(jsonb_build_object('name', left(coalesce(a.value->>'name', ''), 200), 'url', a.value->>'url') order by a.ordinality)
      from jsonb_array_elements(case when jsonb_typeof(m->'attachments') = 'array' then m->'attachments' else '[]'::jsonb end)
           with ordinality as a
      where a.ordinality <= 20
        and (a.value->>'url' like 'https://drive.google.com/%' or a.value->>'url' like 'https://docs.google.com/%')
        and char_length(a.value->>'url') <= 500
    ), '[]'::jsonb),
    coalesce((m->>'received_at')::timestamptz, now())
  from (select value as m from jsonb_array_elements(p_messages) limit 50) as incoming
  where coalesce(m->>'id', '') <> ''
  on conflict (user_id, gmail_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- 誰が呼べるか。合言葉を作るのはログイン中の本人だけ。
-- 届ける側（Gmail のプログラム）はログインしないので、合言葉を持っていれば呼べるようにする。
revoke all on function public.create_mail_token() from public, anon, authenticated;
revoke all on function public.mail_owner(text) from public, anon, authenticated;
revoke all on function public.mail_settings(text) from public, anon, authenticated;
revoke all on function public.mail_unknown(text, text[]) from public, anon, authenticated;
revoke all on function public.receive_mail(text, jsonb) from public, anon, authenticated;
grant execute on function public.create_mail_token() to authenticated;
grant execute on function public.mail_owner(text) to service_role; -- 通知のプログラム（report）が、合言葉から持ち主を確かめる
grant execute on function public.mail_settings(text) to anon, authenticated;
grant execute on function public.mail_unknown(text, text[]) to anon, authenticated;
grant execute on function public.receive_mail(text, jsonb) to anon, authenticated;

-- 追加した表・列・関数を、すぐ使えるようにする
notify pgrst, 'reload schema';
