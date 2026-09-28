# 確認結果 2026-09-28 `api/users` の未ログインアクセス

状態：**確認のみ。コード・本番設定とも未変更。**

## 1. 結論

- **コード上は、ログインなしで社員一覧（氏名・メール・権限・在籍）を返す作りのまま。**
- **ただし本番 `https://erp.b-p.co.jp/api/users` は、2026-09-28 20時頃の実測で500エラー（`X-Vercel-Error: FUNCTION_INVOCATION_FAILED`）となり、データは返らなかった。** 同時に確認した `api/board/posts` も同じ500。
- **現在のフロントエンドは `/api/users` を使っていない**（社員一覧は `dataService.getUsers()` → Supabaseから直接取得）。

## 2. 実測・確認した事実

| 項目 | 内容 |
|---|---|
| `api/users.ts`（Vercel用） | 呼び出し元のログイン確認なし。GETならそのまま `users`・`departments`・`employee_titles` を読む |
| `server/server.js:1139`（Express用） | 同じ処理。ログイン確認なし |
| 使う鍵（`api/_lib/supabaseClient.ts`） | `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY` → `SUPABASE_KEY` → anon鍵 の順で、最初に見つかったもの |
| フロントからの呼び出し | なし（`/api/users` を呼ぶ箇所はテスト・文書のみ） |
| 本番HTTP（未ログインGET） | 500 `FUNCTION_INVOCATION_FAILED`、本文なし。原因はVercelログが見られず未確認 |

### どの鍵かで、漏れる範囲が変わる（DB権限は実測）

| サーバーの鍵 | `users`（77件、うち在籍40） | 部署・役職 |
|---|---|---|
| service_role | **全77件が返る**（BYPASSRLS＋SELECT権限あり） | 返る |
| anon | 0件（anonにSELECT権限はあるが、anon向けポリシーが無い） | 部署は返る（`Public access` ポリシー）、役職は0件 |

Vercel本番にどの鍵が入っているかは未確認（Vercelの確認ツールがエラー）。

## 3. 修正案

**案A（推奨）：`api/users.ts` と `server.js` の `/api/users` を削除する。**
フロントが使っていないため、画面への影響は無い見込み。500エラーが直った瞬間に漏れる、という状態を根本から無くせる。

案B：残す必要があるなら、呼び出し元のSupabaseトークンを検証し、未ログインは401を返す処理を追加する。

どちらもコード変更のため、作業ブランチ→石野さん確認→`origin/main`へマージ→本番反映、の順で行う。

## 4. 調査中に見つかった別の問題（要判断）

`public.users` に、ログイン済みなら誰でも全行を読み書き・削除できるポリシー `rls_migration_authenticated_all`（ALL / `true`）があり、authenticatedにUPDATE・DELETE権限もある。
→ **ログインできる人なら誰でも、他の社員の `role` を `admin` に書き換えたり、社員データを削除したりできる可能性がある**（DB設定から見た推測。実際に書き換えて試してはいない）。
ログイン画面のメールドメイン制限（`@bunsyodo.jp`・`@b-p.co.jp`）は画面側のチェックなので、Supabase側で外部アカウントの登録を止めているかは未確認。

## 5. 確認できなかったこと

- 500エラーの原因（Vercelログ未取得）
- Vercel本番の鍵の種類、`VITE_BYPASS_SUPABASE_AUTH` の値
