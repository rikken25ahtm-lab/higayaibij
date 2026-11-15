-- 「プロジェクト」を追加する。SQL Editor に貼り付けて、Run を1回押してください。（何度 Run しても大丈夫です）
-- プロジェクトは、やることを入れる大きな箱です（例：仕事関係・ウエディング・日常生活）。

create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 50),
  created_at timestamptz not null default now()
);

-- ログインした本人のプロジェクトだけを、読み書きできるようにする
alter table public.projects enable row level security;

drop policy if exists "自分のプロジェクトだけ" on public.projects;
create policy "自分のプロジェクトだけ" on public.projects
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.projects to authenticated;

-- 項目が、どのプロジェクトのものか。プロジェクトをなくしても項目は消えず、「プロジェクトなし」になる
alter table public.items add column if not exists project_id uuid references public.projects (id) on delete set null;
create index if not exists items_project on public.items (project_id);

-- 追加した表と列を、ページからすぐ使えるようにする
notify pgrst, 'reload schema';
