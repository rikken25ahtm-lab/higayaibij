-- 「進捗」の欄を追加する。すでに表を作ってある場合に、SQL Editor で1回だけ Run してください。
alter table public.items add column if not exists progress text not null default '';
