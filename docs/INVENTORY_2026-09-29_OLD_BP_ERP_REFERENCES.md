# 旧bp-erp参照箇所の分類一覧 2026-09-29

対象：mqdriven（ローカル main、origin/main `890cafd` 取り込み後）と、Supabase 旧bp-erp（`rwjhpfghhgstvplmggks`）／bp-erp-pro（`pkwajxeegidydalcannz`）の実測。
状態：**一覧のみ。削除・修正・本番変更はしていない。** 分類は石野さん依頼（2026-09-17回答12）の4区分。

## 0. 最優先：社長報告書がログインなしで公開されている

- `public/turnaround-report.html`（「文唱堂印刷 起死回生プラン ─ 社長報告書（完全版）」、約1.6MB、2026-04-07生成、フッターに旧bp-erp参照）が、**`https://erp.b-p.co.jp/turnaround-report.html` でログインなしに取得できた**（2026-09-29実測、HTTP 200、タイトル一致）。
- `public/` 配下はViteのビルドでそのまま公開される。同じ内容の `文唱堂印刷_起死回生プラン_社長報告書.html`（ルート直下）は公開対象外。
- 対応案：`public/turnaround-report.html` を削除（または `public/` の外へ移動）→ PR → origin/main → 本番反映。**社長・石野さんの判断で至急。**
- `public/` 内の文書類はほかに `__kill_sw.html`（592バイト）と `templates/invoice_format.xlsx`（請求書の雛形）のみ。社内資料と思われるのは本件だけ。

## 1. リポジトリ内の旧プロジェクトID参照（21ファイル）

| # | 場所 | 内容 | 分類 | 根拠・備考 |
|---|---|---|---|---|
| 1 | `public/turnaround-report.html` | 社長報告書のフッター（データ出典） | **判断要（公開停止を推奨）** | 0章のとおり本番で公開中 |
| 2 | `deploy_edge_functions.sh` | `PROJECT_REF` が旧ID（approval-reminder配備用） | 廃止可能（または新IDへ修正） | 実行すると旧環境へ配備される。誤配備防止 |
| 3 | `supabase/migrations/20260218150000_enable_cron.sql` | 旧URLの approval-reminder を毎朝呼ぶcron | 判断要 | 旧・新どちらのDBにも `pg_cron` が無い（実測）→ どちらにも適用されていないと思われる。承認リマインダー機能自体が動いていない可能性 |
| 4 | `scripts/check_db_data.js` | 旧URL＋旧anon鍵を直書き | 廃止可能 | 調査用スクリプト |
| 5 | `scripts/seed_data.js` | 旧URL＋旧anon鍵を直書き | 廃止可能 | 投入用スクリプト。誤実行の危険 |
| 6 | `.codeium/windsurf/mcp_config.json` | 旧IDのSupabase MCP設定 | 廃止可能 | 開発ツールの個人設定 |
| 7 | `components/estimate/PrintEstimateApp.tsx:245` | 画面上の説明文「旧URLからフェッチするよう修正を」 | 判断要 | 画面に表示される文言。新IDへ直すか文言削除 |
| 8 | `supabase/functions/google-oauth-start/index.ts:28` | コメント内の例示 | 歴史資料（修正不要） | 動作に影響なし |
| 9 | `HANDOVER_DOCUMENT.md`、`REQUEST_TO_CHATGPT.md` | 旧接続情報の記載 | 歴史資料・引き継ぎ用 | 冒頭に「旧環境」の注記を入れる程度 |
| 10 | `黒字転換_データ分析レポート.jsx`、`文唱堂印刷_起死回生プラン_社長報告書.html` | レポートのデータ出典 | 歴史資料 | 2026-04-07時点の出典記録 |
| 11 | `docs/` 配下 10ファイル | 調査・引き継ぎ記録 | 歴史資料 | 変更不要 |

`scripts/*.js` の2本に旧bp-erpのanon鍵がGitに入っている。anon鍵は公開前提の鍵だが、旧環境のanon権限の状態次第で意味が変わる（旧環境のanon権限は今回未照会）。

## 2. 旧bp-erpに依存している処理（ID以外の経路）

| 経路 | 実測 | 分類 |
|---|---|---|
| Webサイト問い合わせ → 旧`inquiries` → 同期 → 新`inquiries` → トリガー`trg_create_lead_from_inquiry` → `leads` | 新旧とも49件、最新 2026-09-24（一致）。新側にトリガーあり。同期プログラムはmqdriven内に無い（所在未確認） | **現在使用**（一括削除禁止） |
| 画面が呼ぶEdge Function `send-application-email`（申請メール） | 新側に**未配備**、旧側のみACTIVE | **判断要**：本番で失敗しているか、Vercelの環境変数（`EMAIL_DISPATCH_ENDPOINT`等）で旧側へ向いているかのどちらか。Vercel設定の確認が必要 |
| 画面が呼ぶ `fax-ocr-intake`（FAX OCR） | 新側に未配備、旧側のみ | **判断要**（同上、`VITE_FAX_OCR_ENDPOINT`等） |
| 画面が呼ぶ `google-oauth-disconnect` | 新側に未配備、旧側のみ | 判断要（カレンダー移行設計で扱う） |

新側（bp-erp-pro）に配備済みの関数は5本のみ：`send-invoice-email`、`view-invoice`、`send-test-notification-email`、`send-approval-notification`、`gemini-generate`。

## 3. 旧bp-erpに残るEdge Functions（39本、すべてACTIVE）

| グループ | 関数 | verify_jwt | 分類 |
|---|---|---|---|
| mqdrivenの画面が呼ぶ名前 | send-application-email、fax-ocr-intake、google-oauth-disconnect | true | 判断要（2章） |
| カレンダー・OAuth | google-oauth-start/callback/status、calendar-events、calendar-test、google-calendar-sync、get-google-token、exchange-google-code | 一部false | 移行設計で整理（09-17方針） |
| RAG・同期の試作 | rag_search系13本、embed_rebuild系5本、windsurf_sync系3本、gmail_sync、calendar_sync、manual_knowledge_search、manual_search_fixed、gemini_diagnostic | **すべてfalse** | 廃止候補（2026-01末に一括作成、以後未更新。ただし利用有無は未確認） |
| その他 | gemini-proxy（false）、gmail-fetch、create-project | 混在 | 判断要 |

`verify_jwt=false` の関数は、ログインなしで呼び出せる。中で何をしているか（service_role使用の有無など）は今回未確認。

## 4. 石野さんに確認すること

1. `turnaround-report.html` の公開停止（至急）
2. 申請メール・FAX OCRは本番で動いているか。動いているなら、どの環境変数で旧bp-erpの関数へ向けているか
3. 問い合わせ同期プログラムの所在（どこで動いているか）
4. 旧bp-erpのRAG・同期の試作関数（verify_jwt=false）を停止してよいか
5. 1章の「廃止可能」（#2・#4・#5・#6）を削除してよいか

## 5. 確認できなかったこと

- Vercelの環境変数、Supabaseの通信ログ（ツールのエラー）
- 旧bp-erp各関数の中身と、実際に呼ばれているかどうか
