# 引き継ぎ 2026年9月28日 石野さん回答反映とorigin/mainマージ後の次アクション

## 次回最初に読むもの

1. `CLAUDE.md`（mqdriven）
2. `docs/CONFIRMATION_REQUEST_2026-09-17_ISHINO_ERP.md`（冒頭の状況サマリと、各章「回答（石野さん、2026-09-17）」）
3. 本ファイル
4. 必要に応じて `docs/HANDOFF_2026-09-17_CALENDAR_MIGRATION_REVIEW_AND_PR.md`、`docs/CLAUDE_REVIEW_2026-09-17_CALENDAR_MIGRATION_DESIGN.md`

## 作業開始時に必ず実測すること（本ファイルの数値は書いた時点のスナップショット）

`git status -sb` / `git fetch --all` / `git log --oneline -5` / `git ls-remote personal main` / `git ls-remote fork main` / `gh pr view 144 --repo issy4/mqdriven --json state,mergedAt`

## 作成時点（2026-09-28）の実測状態

- ローカル`main`: マージコミット`ee6b577`（`origin/main`=`0baaec9`を取り込み済み、コンフリクトなし）。**personal/fork（`efb249f`）へは未push**（personal/mainより45コミット先行）。
- [issy4/mqdriven#144](https://github.com/issy4/mqdriven/pull/144)は未マージのOPEN（ドキュメントのみ。マージは石野さん判断）。
- 09-17以降、`origin/main`側で44コミットが進んでいた。今回取り込んだ変更は11ファイル（+4,086/−710行）：`CustomerAnalyticsPage.tsx`新規、`CustomerInfoForm.tsx`大改修（約1,974行）、`CustomerDashboard.tsx`、`CustomerList.tsx`、`ExpenseReimbursementForm.tsx`（税処理）、`App.tsx`、`services/dataService.ts`、`geminiService.ts`（Geminiモデル更新）ほか。
- 09-17のコード検証（`CLAUDE_VERIFICATION_2026-09-17.md`等）は取り込み前のコードが対象。`App.tsx`・`dataService.ts`が変わったため、行番号を引用した箇所は再確認してから使う。

## 石野さん回答の要点（2026-09-17受領、詳細は確認文書）

1. **旧bp-erpは今も本番依存**：Webサイト問い合わせ→`bp-erp.inquiries`→同期プログラム→`bp-erp-pro.inquiries`→トリガーで`leads`自動作成。旧bp-erp参照の一括削除・書き換えは禁止。
2. **`customer_contacts`のanon全CRUDと`api/users`の未ログイン取得は「意図していない」**。優先して現状（GRANT/RLS）と修正案を整理する対象。
3. **本番設定（Supabase/Vercel/Edge Functions/RLS/Gitメインブランチ）の変更は事前確認必須**。修正案の作成・検証までは可。
4. Git運用は`origin/main`一本化の希望。「作業ブランチ→確認・テスト→origin/mainへマージ→Vercel本番反映」。`personal/main`は`origin/main`を定期的に取り込む。
5. 名刺OCRは検証段階。PDF直接送信は意図どおり。Google Driveボタンは意図的に無効。`office-support`/`secretariat`は一括更新せず表示辞書で両対応。OCRリトライ（429/503）は修正案を作成（影響範囲を先に提示）。
6. Vercelプロジェクトは石野さん認識で`mqdriven-pro`。所属・Root Directory・環境変数・デプロイ保護は石野さん側でも未確認（Vercel管理画面で要確認）。
7. OAuth/Calendarの本番正本経路は石野さん側でも未整理。`verify_jwt`の正本も未統一。

**【2026-09-28訂正】下の2問は「未回答」ではなかった。** 石野さんは2026-09-17 18:06 JSTに回答済み（Gmailスレッド「連絡」）。要点：`auth_user_id`はRLSで`auth.uid()`から社員を特定するため一部ユーザーに設定したもの。正式な対応付けは`auth.users.id`→`public.users.auth_user_id`→`public.users.id`。本番コード変更前に16件の`id/auth_user_id/email/name`対応一覧で誤紐付けがないか確認すること。`public.profiles`は業務で使っている認識なし。削除・変更の前に`handle_new_user()`の定義と、アプリ・RLS・Edge Functionsからの参照が無いかを確認し、未使用なら廃止候補。設計書12章「未確認事項」表（`public.profiles`欄）は未更新。

~~**未回答**：`auth_user_id`16件の由来、`public.profiles`39件の用途（09-17 17:56の追加送信分）。~~

## 次のアクション（優先順）

1. **push判断**：ローカルのマージ`ee6b577`を`personal`・`fork`へpushするか、社長に確認する（push先は`personal`と`fork`。PR #144のheadは`fork`）。
2. **`customer_contacts`のGRANT/RLS現状照会＋修正案**（読み取りのみ。適用は石野さん事前確認後）。[[project_bp_erp_pro_anon_exposure]]の09-10記録と突き合わせる。
3. **`api/users`の未ログインアクセス現状確認**（取り込み後の`server`/`api`コードで再確認）。
4. **旧bp-erp参照箇所の分類一覧**（現在使用／歴史資料／廃止可能／判断要）。問い合わせ同期の経路を「現在使用」として必ず含める。
5. **回帰確認（石野さん依頼）**：問い合わせ→leads連携、名刺OCR、`customer_contacts`、顧客管理、認証・権限、Supabase接続先。今回取り込んだ`CustomerInfoForm.tsx`大改修は顧客管理・名刺紐付けに直結するため優先。
6. OCRリトライ修正案、OAuth/Calendar経路の現状棚卸し。
7. カレンダー移行の実装は、設計レビュー反映（済）＋石野さんレビュー＋上記2・3の是正方針が固まるまで着手しない。

## やってはいけないこと

- 石野さんの事前確認なしに、Supabase/Vercel/Edge Functions/RLS/ACL/本番ブランチを変更する。
- 旧bp-erpの関数・データ・参照の削除。
- `server/server.js`の鍵をservice_roleへ切り替える。
- 秘密値（キー・JWT・接続文字列）の出力・記録。
- `personal/main`の作業を石野さんの了承なく`origin/main`へ直接push（403のためできないが、PRは`shoichi-spec/mqdriven-1`から出す）。

## 記録先

- Git: 本ファイル、`CONFIRMATION_REQUEST_2026-09-17_ISHINO_ERP.md`
- Obsidian: `AI-Wiki/wiki/2026-09-17_石野さん回答受領_ERP本番権限とbp-erp依存.md`（09-28時点のマージ結果は未記録。記録する場合は追記）
