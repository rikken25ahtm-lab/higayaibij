-- 「メモ」と「繰り返し」の欄を追加する。SQL Editor に貼り付けて、Run を1回押してください。（何度 Run しても大丈夫です）
alter table public.items add column if not exists notes  jsonb not null default '[]'::jsonb;  -- メモ [{ at, text }]
alter table public.items add column if not exists repeat text  not null default '';           -- '' / daily / weekly / monthly / yearly

-- 追加した列を、ページからすぐ使えるようにする
notify pgrst, 'reload schema';
