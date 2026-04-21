# 開発ログ

実装を進める中で「なぜその選択をしたか」「何にハマったか」「使ってみてどうだったか」を時系列で残す。note 記事化の一次ソース。

---

## 2026-04-22 / プロジェクト開始

### ゴール

- Fitbit のヘルスデータを MCP 経由で取得し、Claude モバイルで分析
- 食事写真を Claude モバイルに投げて、Claude 側が視覚解析した結果を MCP で Fitbit 食事ログに記録
- TypeScript / JavaScript ベース

### 調査からの主要な気づき

3 つのバックグラウンド調査(Fitbit API の現状、MCP / Claude モバイル事情、先行実装サーベイ)を走らせた。詳細は [`research.md`](research.md)。

ここで特に「実装方針を大きく左右した」気づきだけを記しておく:

1. **Fitbit Web API は 2026/09 で消える**。記事や既存の OSS 実装を読んでいる間に複数回「現行の Fitbit API 叩いてるだけ」のコードを見たが、Google Health API への移行を前提にしないと数ヶ月で陳腐化する。**→ Provider-agnostic 設計を最初から組み込む**。
2. **Claude モバイルから OAuth を完結させるのは難しい**。Fitbit 側は Google Account 統合済みのユーザーでは実質 Google OAuth 経由になるが、Google OAuth は `disallowed_useragent` ポリシーで埋め込み WebView をブロックする。Claude アプリの内蔵ブラウザ挙動が信頼できないため、**初回認可は PC のシステムブラウザで CLI から 1 回だけ踏む方式にする**(このおかげで実装もシンプルになる)。
3. **Claude モバイルは stdio MCP が動かない**(サブプロセス不可)。つまり `npm install -g hogehoge/mcp` → `command: "npx"` の Desktop 方式は使えない。モバイル利用を真に受けるなら **公開 URL が必要 = デプロイ**。最初この勘違いで時間を取られかけたが、プランモードで早い段階に気づけて助かった。
4. **Fitbit Food Log は 2025/11 から Search/Barcode 障害中**。`Search Foods` に頼る実装は不安定。`foodName` + `calories` を直接投げる方式にする。これは偶然、日本食のサポート(検索 DB が米国寄り)にも都合が良い。
5. **先行実装 `TheDigitalNinja/mcp-fitbit` は read-only**。書き込み系が丸々手つかずの領域。`log_meal_photo` と一緒に書き込み系全部盛りで差別化できる。

### 採った設計判断

- Runtime: **Cloudflare Workers**(Streamable HTTP、Node.js compat)。無料枠、モバイル対応、常時稼働、デプロイが軽い
- SDK: `@modelcontextprotocol/sdk` の `McpServer` + `registerTool` + `zod/v4`
- セキュリティ: URL パスに `MCP_SHARED_SECRET` 埋め込み + Anthropic 公式 outbound CIDR `160.79.104.0/21` allowlist の二重
- OAuth: CLI で 1 回だけ PC のブラウザで認可、`refresh_token` を Workers KV に保存、Worker 内で 8 時間毎に自動 refresh
- 画像: MCP サーバーは画像を一切受け取らない。Claude 側で視覚解析 → `items[]` を tool 引数で受け取るだけ
- Public OSS(MIT)。secrets はコードに入れない

### 今日の作業

- プロジェクトディレクトリ作成
- `git init` / `.gitignore` / MIT LICENSE / README 雛形
- `docs/research.md` に調査結果を保存
- `docs/journal.md`(このファイル)を開始
- Cloudflare Worker 基盤を scaffold
  - `package.json`(pnpm、`type: module`、scripts: dev/deploy/setup:fitbit/test/typecheck/lint/format)
  - `tsconfig.json`(ES2022 / Bundler / strict + noUncheckedIndexedAccess / types に workers + node 両方)
  - `biome.json`(Biome 2.x の `files.includes` 書式、single quote / semicolons always / trailing commas all)
  - `wrangler.toml`(compat date 2025-11-01、`nodejs_compat` フラグ、`[vars].ALLOWED_CIDRS = "160.79.104.0/21"`。KV と secrets は後のマイルストーンで有効化する方針でコメントアウト)
  - `wrangler.toml.example`(Public OSS 向けテンプレ、KV id プレースホルダ)
- 依存インストール:`@modelcontextprotocol/sdk@^1.29`、`hono@^4.7`、`zod@^3.25`(ランタイム)、`wrangler@^4`、`typescript@^5.7`、`vitest@^2`、`@biomejs/biome@^2`、`@cloudflare/workers-types`、`tsx@^4`、`@types/node@^22`(dev)
- `src/env.ts`(Env バインディング型)
- `src/index.ts`(Hono app、`/` と `/health`。`/mcp/:secret` は後続マイルストーン)
- `pnpm typecheck` / `pnpm lint` / `wrangler dev` で疎通確認。`curl /health` で `{"status":"ok","mcpProtocolVersion":"2025-06-18"}` が返る

### メモ

- Zod は v3.25 系を採用。SDK 内部は `zod/v4` だが標準 `zod` path では v3 後方互換で問題ない(SDK >= 1.17.5 の報告)。必要になれば v4 へ上げる。
- Wrangler v4 で KV の `preview_id` は不要。dev 時のローカル KV は自動でモックされる。本番 deploy 前に `wrangler kv:namespace create` で実 id を入れる。
- Biome 2.x では `files.ignore` → `files.includes` 配列に否定パターン(`"!node_modules"` 等)を入れる書式に変わっている。

---

## 2026-04-22 / セキュリティ層(SECRET + CIDR allowlist)

`src/auth/guard.ts` に実装。純粋関数 `verifyAccess(input)` + Hono 向けの `guardMiddleware()` を分離して、テスト容易性を担保。

### 設計メモ
- IPv4 を 32bit 整数に畳んで CIDR 比較。IPv6 は allowlist 対象外(Anthropic の公表 outbound は IPv4 `160.79.104.0/21` のみなので実害なし)
- `parseCidrList` は `ALLOWED_CIDRS` env を comma-separated で複数対応。将来 Anthropic が追加 CIDR を出した際に env 更新だけで追随できる
- SECRET 比較は `timingSafeEqual` で定数時間(文字列長が一致しない場合だけ早期 return、その後は常に全文字走査)
- 失敗時の reason 文字列は 5 種類(`missing_secret` / `secret_mismatch` / `missing_client_ip` / `no_cidr_configured` / `ip_not_allowed`)。401 / 403 に分けて返す

### テスト結果
`test/auth/guard.test.ts` に 17 ケース(`ipv4ToInt` の malformed 拒否、`isIpv4InCidr` で /0 と /32、`parseCidrList`、`timingSafeEqual`、`verifyAccess` の 8 パス)。全て緑。

### 実機での気づき
`wrangler dev` 下で curl すると、**Wrangler がローカルリクエストに自動で `CF-Connecting-IP` ヘッダを注入してくる**。ヘッダ未指定 curl でも `missing_client_ip` ではなく `ip_not_allowed` が返った(127.0.0.1 が埋められていた)。本番の Cloudflare エッジでも必ずこのヘッダが入るので実害はないが、「ヘッダが無い時の経路」は純粋関数テストでしかカバーできない、と実感。

### 挙動確認
.dev.vars に `MCP_SHARED_SECRET=test-secret-abc` を置いて `wrangler dev`、4 パターン curl:

| シナリオ | 結果 |
|---|---|
| 間違った secret | 401 `secret_mismatch` ✓ |
| 正 secret + IP ヘッダ無し | 403 `ip_not_allowed` ✓(ローカルでは Wrangler が 127.0.0.1 を埋める) |
| 正 secret + CIDR 外 IP(1.2.3.4) | 403 `ip_not_allowed` ✓ |
| 正 secret + CIDR 内 IP(160.79.104.5) | 501 `mcp_transport_not_yet_wired` ✓(guard 通過の合図、MCP 本体は次以降のマイルストーン) |
