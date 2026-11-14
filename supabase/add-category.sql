-- 「カテゴリ」の欄を追加する。SQL Editor に貼り付けて、Run を1回押してください。（何度 Run しても大丈夫です）
alter table public.items add column if not exists category text not null default '';

-- 追加した列を、ページからすぐ使えるようにする
notify pgrst, 'reload schema';
