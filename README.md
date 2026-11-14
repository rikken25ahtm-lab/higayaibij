# ひがやいびん

2号店オープン準備のための「やること」ページ。

## 今できること（第1段階：ページと保存）

- やることの追加・編集・完了・削除（内容 / 必要な対応 / 誰に任せるか / 期限）
- 期限の近い順に表示。期限切れ・今日・3日以内は色で目立たせる
- 完了した項目は下にまとめて薄く表示
- スマホとパソコンの両方の画面幅に対応
- Supabase に保存してログインで守る（設定したとき）

## 保存について（大事）

`config.js` が空のあいだは、**開いた端末のブラウザの中** に保存します（同期なし・ログインなし）。

`config.js` に Supabase の Project URL と Publishable（anon）キーを入れると、
Supabase に保存するようになり、ログイン画面が出ます。ログインした本人の項目だけが読み書きできます。
テーブルの定義は `supabase/schema.sql` にあります。

## 開き方

ビルドは不要です。`index.html` をブラウザで開くか、次のように配信します。

```
python3 -m http.server 8000   # → http://localhost:8000
```

## テスト

```
node --test
```

## ファイル

| ファイル | 役割 |
| --- | --- |
| `index.html` / `style.css` | 画面 |
| `app.js` | 画面の動き |
| `logic.js` | 並べ替え・期限の判定（テストあり） |
| `store.js` | 保存（端末内） |
| `supabase-store.js` | 保存とログイン（Supabase） |
| `config.js` | Supabase の接続先 |
| `supabase/schema.sql` | Supabase に作るテーブル |
| `vendor/supabase.js` | Supabase 公式ライブラリ（supabase-js 2.119.0） |
