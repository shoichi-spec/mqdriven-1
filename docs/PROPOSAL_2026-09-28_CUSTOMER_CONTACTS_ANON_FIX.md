# 修正案 2026-09-28 customer_contacts の匿名（anon）アクセス遮断

対象：Supabase `bp-erp-pro`（`pkwajxeegidydalcannz`）`public.customer_contacts`
状態：**案のみ。本番未適用。** 適用は石野さんの事前確認後（2026-09-17回答3）。

## 1. 現状（2026-09-28 実測、読み取りのみ）

| 項目 | 実測値 |
|---|---|
| 行数 | 1,307（`migrated_from_customers` 1,293／`business_card_ocr` 14） |
| 最終作成・更新 | 作成 2026-09-11、更新 2026-09-11（09-17以降の新規作成0件） |
| RLS | 有効（FORCEなし） |
| anon の GRANT | SELECT / INSERT / UPDATE / DELETE |
| authenticated の GRANT | SELECT / INSERT / UPDATE / DELETE |
| service_role の GRANT | **なし**（BYPASSRLSはあるがACLが無いので読み書き不可） |
| ポリシー | select / insert / update / delete の4本、すべて `TO anon, authenticated`、条件 `true` |
| 参照する関数・ビュー・トリガー | なし。外部キーは `customer_id → customers` のみ |

→ **ログインなしで、1,307件の氏名・メール・電話・住所の閲覧、追加、書き換え、削除ができる状態**（09-10の記録と同じで、未是正）。

## 2. アプリ側の使い方（mqdriven 現行コード `c1d6be0`）

- 使っているのは `services/dataService.ts` の3か所のみ：INSERT（6572行）、SELECT（6631行）、UPDATE（7199行）。**DELETEはコードに無い。**
- ブラウザのSupabaseクライアント（anonキー）で呼ぶが、ログイン済みなら通信はログインユーザーのトークン（`authenticated`）になる。
- `App.tsx:458` のとおり、`VITE_BYPASS_SUPABASE_AUTH=1` でない限りログイン必須。`1` にしているのは `playwright.config.ts`（テスト用）だけ。
- `server/server.js`・Edge Functions・ローカルの他リポジトリには `customer_contacts` を使う箇所なし。

## 3. 修正案（第1段：anonだけ外す）

ログイン済みユーザーの動作は変えず、未ログインからのアクセスだけを止める。

1. 4本のポリシーの対象ロールを `anon, authenticated` → `authenticated` に変更（`ALTER POLICY ... TO authenticated`）
2. `anon` から SELECT/INSERT/UPDATE/DELETE を REVOKE

SQL：`docs/sql/2026-09-28_customer_contacts_anon_fix.sql`（適用文と復元文は `/* */` で封印済み）

### 影響

- 名刺登録・一覧・編集（ログイン後の画面）：**変わらない見込み**（authenticatedのまま）
- 未ログインのアクセス：拒否される（これが狙い）
- 本番で `VITE_BYPASS_SUPABASE_AUTH=1` にしていた場合：名刺画面が使えなくなる → **適用前にVercelで値の確認が必要（未確認）**

### 適用後の確認（同じSQLファイルの「検証」節）

- `set local role anon` で SELECT → `permission denied` になること
- `set local role authenticated` で SELECT → 1,307件前後が返ること
- 本番画面：ログインして名刺連絡先一覧の表示・編集ができること

### 戻し方

同じファイルの「復元」節（ポリシーを `anon, authenticated` に戻し、anonへ再GRANT）。

## 4. 第2段（今回は案の提示のみ）

- **authenticated = 社員、とは限らない**。`RegisterPage.tsx` にGoogle OAuthでの新規登録があり、Supabaseの新規登録を誰でもできる設定になっているかは未確認。できるなら、外部の人がアカウントを作って全件を読める。
  → ポリシー条件を `true` から「`public.users` に登録された有効な社員」に絞る案を別途作る（社員テーブルと `auth.uid()` の対応を先に確認する必要あり。`auth_user_id` 16件の由来の件は石野さんの回答待ち）。
- アプリにDELETEが無いので、`authenticated` からDELETEを外すことも検討できる（将来削除機能を作る予定があるかは石野さん判断）。

## 5. 石野さんに確認すること

1. 第1段（anon遮断）を本番に適用してよいか。適用のタイミング
2. Vercel本番（`mqdriven-pro`）の `VITE_BYPASS_SUPABASE_AUTH` は未設定または `0` か
3. `customer_contacts` を、mqdriven以外（同期プログラム・外部ツール等）から、ログインなしで読み書きしていないか
4. Supabase Authで誰でも新規登録できる設定か（第2段の前提）

## 6. 確認できなかったこと

- Supabaseの通信ログ・Vercel環境変数：MCPツールがエラーを返したため未取得。実際にanonでアクセスされているかどうかは、今回わかっていない。
