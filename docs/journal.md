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

---

## 2026-04-22 / OAuth bootstrap CLI

`scripts/setup-fitbit.ts`(tsx で実行)。Node 組み込み `http` で `127.0.0.1:8787/fitbit/callback` に一時サーバーを立て、PKCE(code_challenge S256)付きで認可 → code を token に交換 → 結果を表示 + Cloudflare 投入コマンドを案内する、というワンショット CLI。

### 実装メモ
- **依存追加なし**:`@hono/node-server` は使わず Node 標準 `http` で callback を受ける。依存はすでに入っている `zod` だけで token response をパース
- **PKCE**:`randomBytes(32)` を base64url 化して verifier、SHA-256 して challenge。RFC 7636 準拠
- **state**:16 bytes 乱数、callback 側で厳密一致を検証(CSRF 対策)
- **Token 交換**:`POST /oauth2/token` は Basic Auth(`client_id:client_secret`)+ `grant_type=authorization_code`。Fitbit Personal App でも Basic Auth は必須(PKCE 必須ではないが、ここでは両方使って一番堅い形に)
- **スコープ**:`activity heartrate sleep nutrition profile weight respiratory_rate oxygen_saturation temperature cardio_fitness settings`。将来 ECG や HRV(heartrate に内包)などが増えてもここを伸ばすだけで対応
- **ブラウザ自動 open**:macOS `open`、Linux `xdg-open`、Windows `start` を best effort。失敗しても URL を stdout に出してあるのでユーザーがコピペ可能
- **ログ**:access/refresh の中身はマスク(先頭 6 + 末尾 4 + 文字数)。ただし `wrangler kv:key put` の案内では生値を印字する(これを手でコピペする想定で、端末履歴を消す運用は README で注意喚起)
- Fitbit の `expires_in` は 28800 秒(8 時間)だが、保存する `expires_at` は単純に `now + expires_in` にして、Worker 側で 60 秒前に先読み refresh する(実装は次マイルストーン)

### 挙動確認
ENV 未設定での早期 exit が意図通り:
```
$ env -u FITBIT_CLIENT_ID -u FITBIT_CLIENT_SECRET pnpm run setup:fitbit
Error: FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET must be set.
  1. Create a Personal app at https://dev.fitbit.com/apps/new
     Callback URL: http://127.0.0.1:8787/fitbit/callback
  ...
```

実際の OAuth ラウンドトリップは、ユーザーが dev.fitbit.com で Personal App を作成してから:
```
$ export FITBIT_CLIENT_ID=XXXXXX
$ export FITBIT_CLIENT_SECRET=YYYYYY...
$ pnpm run setup:fitbit
```
を実行する。これはリポジトリには残らない一時セッション、かつユーザー側の行動なので、動作確認は Worker 内 `oauth.ts` の refresh と組み合わせた次マイルストーンで初めて実データで検証する。

---

## 2026-04-22 / Fitbit クライアント基盤

`src/lib/`(汎用)と `src/providers/fitbit/`(ドメイン)に基盤を実装。

### レイヤ
- `src/lib/errors.ts` — `FitbitAuthError` / `FitbitApiError` / `FitbitRateLimitError` と、MCP ツール結果に変換する `toolErrorResult()`。Auth エラー時は「`setup:fitbit` 再実行を促すヒント」を自動で添える(モバイルで落ちた時に復旧手順が見えるのは実用重要)
- `src/lib/date.ts` — `toJstDateString()` / `todayJst()` / `assertIsoDate()` / `normalizeRange()`。食事ログなどの日付はユーザー体感と合うよう JST で閉じる
- `src/lib/rate-limit.ts` — `parseRetryAfter()`(delta-seconds のみ扱い、HTTP-date は fallback に倒す。1〜30 秒にクランプ)、`sleep()`
- `src/lib/cache.ts` — `getCached()` / `invalidate()` / `cacheKey()`。Workers KV を TTL 1h で使う。`cacheKey` は args をアルファベット順 sort で安定化
- `src/providers/fitbit/oauth.ts` — `getAccessToken()` が通常パス。`expires_at - 60s < now` なら自動で `refreshTokens()`。refresh は `POST /oauth2/token` に Basic(client_id:client_secret)+ `grant_type=refresh_token`。KV には 4 キー(`access_token` / `refresh_token` / `expires_at` / `user_id`)を atomic-ish に保存。並行 refresh の競合は Fitbit の「2 分以内の同一 refresh_token に同一レスポンスを返す」仕様に便乗して KV-CAS ロック不要とした
- `src/providers/fitbit/client.ts` — `FitbitClient#requestText()` / `requestJson(schema, req)`。Bearer 注入、401 時は `invalidateAccessToken()` + 1 回リトライ、429 時は `Retry-After` 尊重で最大 1 回リトライ、`ZodType` 渡しでレスポンス検証

### 設計メモ
- Fitbit 書き込みは `application/x-www-form-urlencoded`(JSON body は公式には未推奨)。`FitbitRequest.form` を `URLSearchParams` 化する分岐にしてある
- `requestJson` の schema validation が失敗した場合は `FitbitApiError` として扱う(200 OK でも仕様外ペイロードなら同じ扱い)
- `FitbitClient` はステートレス。`new FitbitClient(env)` が Worker リクエスト毎に作られても KV や `env.TOKENS` の共有で問題ない

### wrangler.toml の KV
`TOKENS` / `CACHE` の bindings を `wrangler.toml` に追加。本番 id は `wrangler kv:namespace create` 実行後に差し替えだが、**placeholder id のままでも `wrangler dev` は local SQLite-backed KV を使って起動する**ことを実機で確認(wrangler v4.84):
```
env.TOKENS (local-tokens-placeholder)   KV Namespace   local
env.CACHE  (local-cache-placeholder)    KV Namespace   local
```
`.dev.vars` の `MCP_SHARED_SECRET` も "(hidden)" として bind されている。

### テスト
45 テスト緑(既存 17 + date 17 + rate-limit 7 + cache 4)。oauth.ts と client.ts は KV / fetch モックを要するため、マイルストーン 9(テスト整備)でまとめて。

### まだやらないこと
`get_profile` 実疎通は、ユーザーの dev.fitbit.com アプリ作成 + `setup:fitbit` 実行 + `wrangler kv:key put` まで揃ってから。Worker 側から Fitbit API を叩く route がまだ /mcp/:secret の 501 スタブしかないので、次マイルストーン(Provider 抽象 + Read 実装)で FitbitProvider を完成させてから MCP ツールとして wire up する。
