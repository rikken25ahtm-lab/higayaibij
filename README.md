# ひがやいびん

2号店オープン準備のための「やること」ページ。

## 今できること（第1段階：ページと保存）

- やることの追加・編集・完了・削除（内容 / 必要な対応 / 進捗〔まだ・途中・返事待ち〕/ 誰に任せるか / 期限）
- AIに決まった形で要約してもらった文を貼り付けて、まとめて追加（確認してから追加。お願い文は画面からコピーできる）
- 期限の近い順に表示。期限切れ・今日・3日以内は色で目立たせる
- 完了した項目は下にまとめて薄く表示
- スマホとパソコンの両方の画面幅に対応
- Supabase に保存してログインで守る（設定したとき）

## 通知（第3段階：朝10時・夕方17時の報告）

毎日 朝10時と夕方17時（日本時間）に、期限切れ・今日・3日以内のやることを、スマホの通知でお知らせします。
急ぎがなければ「急ぎはありません」と1行で届きます。Supabase に保存しているときだけ使えます。

### 最初の設定（1回だけ）

1. **通知を送るプログラムを Supabase に置く**
   Supabase の画面で「Edge Functions」→「Deploy a new function」→「Via Editor」を開き、
   名前を `report` にして、`supabase/functions/report/index.ts` の中身をそのまま貼り付けて Deploy します。
2. **「Verify JWT」をオフにする**
   作った `report` の設定（Details）で「Verify JWT with legacy secret」をオフにして保存します。
   （時刻の予約からの呼び出しを通すためです。本人確認はプログラムの中で行っています）
3. **テーブルと時刻の予約を作る**
   「SQL Editor」に `supabase/add-notifications.sql` を貼り付けて、Run を1回押します。
4. **iPhone のホーム画面に追加する**
   Safari でページを開き、共有ボタン →「ホーム画面に追加」。以後はホーム画面のアイコンから開きます
   （初回はもう一度ログインが必要です）。
5. **通知を受け取る**
   ページ下の「通知」欄で「通知を受け取る」を押し、許可します。
   「今すぐ試しに送る」を押して、通知が届けば完了です。

### 仕組み

- 時刻になると Supabase（pg_cron）が `report` を呼び、`report` が登録済みの端末へ通知を送ります。
- 同じ回の報告は1度しか送りません。朝10時台・夕方17時台以外に呼ばれても送りません。
- 通知の署名に使う鍵は `report` が初回に自動で作り、ページからは読めないテーブルに保存します。
- ログアウトすると、その端末への通知は止まります。

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
| `push.js` / `sw.js` | 通知の設定と、通知の表示 |
| `manifest.webmanifest` / `icons/` | ホーム画面に追加するための設定とアイコン |
| `supabase/functions/report/index.ts` | 通知を送るプログラム（Supabase の Edge Function。テストあり） |
| `supabase/add-notifications.sql` | 通知用のテーブルと、朝10時・夕方17時の予約 |
| `vendor/supabase.js` | Supabase 公式ライブラリ（supabase-js 2.119.0） |
