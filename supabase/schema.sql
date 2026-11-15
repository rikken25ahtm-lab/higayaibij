-- ひがやいびん：やることの保存先
-- Supabase の「SQL Editor」に貼り付けて、Run を1回押してください。

create table public.items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content     text not null check (char_length(content) between 1 and 200),  -- 内容
  category    text not null default '',                                      -- カテゴリ
  action      text not null default '',                                      -- 必要な対応
  progress    text not null default '',                                      -- 進捗
  assignee    text not null default '',                                      -- 誰に任せるか
  due         date,                                                          -- 期限
  status      text not null default 'open' check (status in ('open', 'done')),
  priority    text check (priority in ('near', 'mid', 'last')),              -- 使っていない（直近は、期限から自動で決める）
  attachments jsonb not null default '[]'::jsonb,                            -- 添付（ドライブ）とメールのリンク
  notes       jsonb not null default '[]'::jsonb,                            -- メモ [{ at, text }]
  repeat      text not null default '',                                      -- 繰り返し（daily / weekly / monthly / yearly）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ログインした本人の項目だけを、読み書きできるようにする
alter table public.items enable row level security;

create policy "自分の項目だけ" on public.items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.items to authenticated;

-- プロジェクト（やることを入れる大きな箱）は、続けて supabase/add-projects.sql を Run して作ります。
