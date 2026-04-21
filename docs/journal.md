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

---

## 2026-04-22 / Provider 抽象と 16 Read メソッド実装

`HealthProvider` interface を `src/providers/types.ts` に置き、`FitbitProvider` に 16 の read メソッドを実装。ファイル構成は Fitbit API のカテゴリに合わせて分割:

| ファイル | 実装したメソッド |
|---|---|
| `profile.ts` | `getProfile` |
| `device.ts` | `listDevices` |
| `activity.ts` | `getDailySummary` / `getActivityTimeSeries` / `getExerciseList` |
| `heart.ts` | `getHeartRateRange` / `getHeartRateIntraday` |
| `sleep.ts` | `getSleep` / `getSleepRange`(v1.2) |
| `body.ts` | `getBodyLog`(weight + fat を parallel fetch して merge) |
| `nutrition.ts` | `getFoodLog`(Search Foods は意図的に未公開 → 2025/11 障害回避) |
| `metrics.ts` | `getSpO2` / `getRespiratoryRate` / `getSkinTemperature` / `getHRV` / `getCardioFitness` |

### Fitbit レスポンスの癖
- **Activity Time Series** は `activities-<resource>` の動的キー。`z.record` で受けて key を組み立てて抽出
- **Heart Rate Range/Intraday** は `activities-heart` と `activities-heart-intraday` に二重階層。intraday の戻り値はフラットな `HeartRateIntraday` shape に畳んだ(`{date, detailLevel, restingHeartRate, heartRateZones, points[]}`)
- **Sleep v1.2** は `{sleep: SleepLog[]}`、`levels.data` / `levels.shortData` の stage データは保持(LLM が深さ分析できる)
- **Body** は weight と fat で別エンドポイント → Promise.all で並列
- **SpO2 range** だけ top-level 配列。他(`br` / `tempSkin` / `hrv` / `cardioScore`)は outer key でラップされている
- **Cardio Fitness** は `cardioScore[0].value.vo2Max` が string(「45-49」)か number。zod は `z.union` で両対応

### Provider 抽象の割り切り
- 戻り値型は Fitbit 形式の zod.infer をそのまま expose(Profile, SleepLog 等)
- Google Health 実装時は、Google Health API の JSON → この同じ shape に adapt する方針。どうしても収まらない場合だけ interface を「意味 unit」に書き直す

### Cache はまだ挟まない
Provider 層は stateless で Fitbit を直叩きするだけ。Cache / invalidation は tool 層(M7)で `getCached(env, cacheKey('get_food_log', {date}))` の形で挟む予定。

### 全 4 コミットの分割
1. `feat(providers): HealthProvider interface + FitbitProvider skeleton` — 全 stub
2. `feat(fitbit): activity + heart-rate reads` — +5
3. `feat(fitbit): sleep, body, and food-log reads` — +4
4. `feat(fitbit): metrics (SpO2 / BR / skin temp / HRV / cardio fitness)` — +5

計 16 reads 完成。残りは tool 層(M7)と write 層(M8)と metrics 系のツール(M7 内)。

---

## 2026-04-22 / MCP Streamable HTTP 接続と最初の 2 tool

### @hono/mcp 採用
Cloudflare Workers + Hono 構成で MCP の Streamable HTTP transport を扱うため、`@hono/mcp@^0.2`(Hono 公式拡張)を追加。`StreamableHTTPTransport` class が提供されていて、Hono の `Context` を直接受ける `handleRequest(c)` がある。自前で Fetch API ↔ Node `IncomingMessage` adapter を書かずに済む。

```ts
app.post('/mcp/:secret', guardMiddleware(), async (c) => {
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.text('', 200);
});
```

### 実機確認
curl で initialize を投げて `{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"fitbit-logger-mcp","version":"0.1.0"}}}` が SSE stream で返る。

続けて `tools/list` を叩くと:
- `get_profile`(inputSchema 空、outputSchema に Profile の JSON Schema)
- `list_devices`(outputSchema に devices array)

の 2 ツールが list される。stateless モード(`Mcp-Session-Id` なし)で動作。

### 設計ポイント
- `src/server.ts` の `buildServer(env)` がリクエスト毎に新しい McpServer を返す。Cloudflare Workers の 1 request = 1 Worker instance モデルに素直
- `src/tools/index.ts` の `registerAllTools` で全 tool を束ねる。1 tool = 1 ファイル、カテゴリディレクトリで整理(`tools/read/...`, `tools/write/...`)
- Cache は tool 層で `getCached(env, cacheKey('get_profile'), () => provider.getProfile())` の形で挟む。provider は stateless のまま
- Output は `structuredContent` + `content: [{type:'text', text: JSON.stringify(...)}]` の両方。2025-06-18 spec の推奨
- Zod の `ProfileSchema.shape` を outputSchema にそのまま渡す(SDK が JSON Schema に変換して tools/list にも expose)

### 16 read tool 完成
4 コミットで activity(3) + heart(2) + sleep(2) + body(1) + nutrition(1) + metrics(5)= 14 を足し、計 16 read tool。実機の `tools/list` が以下を返すことを確認:

```
get_profile / list_devices / get_daily_summary / get_activity_timeseries /
get_exercise_list / get_heart_rate_range / get_heart_rate_intraday /
get_sleep / get_sleep_range / get_body_log / get_food_log / get_spo2 /
get_respiratory_rate / get_skin_temperature / get_hrv / get_cardio_fitness
```

---

## 2026-04-22 / Fitbit Write + Write ツール 8 個(M8 + M9)

`FitbitProvider` の 8 write メソッドを実装 → tool 層の 8 write ツールを登録。

### Fitbit Write API(全て form-urlencoded body)
- `POST /1/user/-/foods/log.json` — `foodName` + `calories` + `mealTypeId`(1=B/2=MS/3=L/4=AS/5=D/7=Anytime)+ `nutritionalValues.<key>`
- `POST /1/user/-/foods/log/water.json?date&amount&unit=ml`
- `DELETE /1/user/-/foods/log/{logId}.json`
- `POST /1/user/-/body/log/weight.json` — date, weight(kg), time?
- `POST /1/user/-/body/log/fat.json` — date, fat(%)
- `POST /1/user/-/activities.json` — activityId or activityName + manualCalories、startTime(HH:mm:ss)、durationMillis、date、distance?
- `POST /1.2/user/-/sleep.json` — startTime(HH:mm)、duration(ms)、date

### MCP tool の目玉: `log_meal_photo`
input:
- `mealType`: Breakfast / MorningSnack / Lunch / AfternoonSnack / Dinner / Anytime
- `items[]`: `{name, estimatedGrams?, calories, protein?, carbs?, fat?, confidence?}`
- `date?`: JST デフォルト
- `notes?`

description は Claude への挙動指示を明示:
- 写真解析「後」に 1 回呼ぶ
- 複数 item を sequential で書き込む(partial failure を可視化、150/h ceiling を突き抜けない)
- 日本語の name OK、confidence で sanity check を促す
- 後悔したら `delete_food_log(logId)` で巻き戻せる

### Cache invalidation
Write 成功時に関連 read の KV cache を自動 invalidate:
- log_food / log_meal_photo / log_water / delete_food_log → `get_food_log:date` + `get_daily_summary:date`
- log_weight → `get_daily_summary:date`
- log_activity → `get_daily_summary:date` + `get_exercise_list:beforeDate=date`
- log_sleep → `get_sleep:date`

range cache(body/heart/sleep/hrv/spo2 の start-end 指定)は TTL 1h で自然失効に任せる(厳密 invalidate には index が必要で overkill)。

### 実機確認
`wrangler dev` 下で `tools/list` が 24 tools を返すことを確認:
- **Read 16**: activity_timeseries / body_log / cardio_fitness / daily_summary / exercise_list / food_log / heart_rate_intraday / heart_rate_range / hrv / profile / respiratory_rate / skin_temperature / sleep / sleep_range / spo2 / list_devices
- **Write 8**: delete_food_log / log_activity / log_body_fat / log_food / log_meal_photo / log_sleep / log_water / log_weight

### 注意
`log_activity` の input で、`activityId` か `activityName + manualCalories` のどちらか必須。`activityName` + `manualCalories` 欠落時は RangeError を返す client-side validation を入れた。

---

## 2026-04-22 / リポ名変更: fitbit-logger-mcp → fitbit-googlehealth-mcp

Public 化直前のリネーム。

### 理由
Provider 抽象を最初から組み込んでいるのに、リポ名が Fitbit 固有だと設計意図が伝わらない。本プロジェクトが解こうとしている過渡期そのもの——**2026/09 の Fitbit Web API 停止 → Google Health API 移行**——を name で表現するため `fitbit-googlehealth-mcp`。

`health-logger-mcp`(抽象名詞派)も候補に挙がったが、具体性と記事化の「物語性」を優先。2026 年時点の main provider はまだ Fitbit、でも寿命は分かっていて移行先は Google Health、という現実を name に残しておく方が、後から見て何のリポか分かりやすい。

### 置換対象
- `package.json` の `name` と `description`
- `wrangler.toml` / `wrangler.toml.example` の `name`(= デプロイ URL の subdomain)
- `src/server.ts` の `McpServer({ name })`(= `serverInfo.name`、tools/list 応答で client に見える)
- `src/index.ts` の root route 文字列と `/health` の `service` field
- `README.md` 全体(タイトル、clone URL、デプロイ URL 例)
- ローカルディレクトリも `fitbit-googlehealth-mcp` にリネーム

テストの一部(`oauth.test.ts` の fetchMock 引数)は Biome の unused-param ルールの衝突をきれいにするため合わせて調整。

### 設計メモ
過去の journal entry の中で `serverInfo.name` の実値を `"fitbit-logger-mcp"` として引用している箇所があるが、これは当時の実測値なのでそのまま残した(置換すると履歴として嘘になる)。今後の entry では新しい name を使う。
