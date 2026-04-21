# 設計前調査(2026-04 時点)

本プロジェクトの設計前にバックグラウンド調査で集めた情報をまとめる。Fitbit MCP を実装しようとする人の 2026 年時点のスタート地点になるように、出典 URL を付けた状態で残す。

目次:
1. Fitbit Web API の現状と 2026/09 の崩壊
2. ユーザーアカウントの Google 統合
3. OAuth 2.0(PKCE、スコープ、トークン)
4. 取得できるデータの網羅
5. 食事ログ書き込みの実情
6. レート制限
7. Intraday の条件
8. MCP TypeScript SDK と Streamable HTTP
9. Claude モバイルの MCP 接続経路
10. 画像を Claude モバイル → MCP で扱う方法
11. Remote MCP での OAuth の設計パターン
12. 先行実装サーベイ
13. デプロイ先の選択肢
14. まとめ:本プロジェクトが採った設計

---

## 1. Fitbit Web API の現状と 2026/09 の崩壊

- **Fitbit Web API(`api.fitbit.com`)は 2026/09 に完全停止**。後継は **Google Health API**(`https://health.googleapis.com/v4/`)。Fitbit・Pixel Watch・サードパーティデバイスのデータを統一された Google Cloud インフラで扱う設計
- API 面積は 100+ のレガシー・エンドポイントから data type bundle 単位にコンソリデート
- 2 系統のデータストリームを提供:
  - **Reconciled Stream**(複数ソースを突合、Fitbit アプリ表示と整合)
  - **Device & Manual Log Stream**(生データ、ユーザー手動入力)
- 認証は **Google OAuth 2.0**。**既存 Fitbit OAuth トークンは移行不可** → 再同意必須
- 2026/05 末まではブレイキングチェンジの可能性あり。本番ローンチは 5 月末以降推奨
- Google Fit REST API は 2026 年末までで段階的に終了、新規サインアップは 2024/05/01 以降受付停止
- Health Connect(Android 上のオンデバイス hub)は **サーバーサイドでクラウドから Fitbit データを取る用途に使えない**。クラウド統合は Google Health API 一択

出典:
- [Google Health API - About](https://developers.google.com/health/about)
- [Google Health API - Migration guide](https://developers.google.com/health/migration)
- [Google Health API - Endpoints](https://developers.google.com/health/endpoints)
- [Google Health API - Release notes](https://developers.google.com/health/release-notes)
- [Fitbit API Deprecation - Thryve](https://www.thryve.health/blog/fitbit-api-deprecation)
- [Google Fit Migration FAQ](https://developer.android.com/health-and-fitness/health-connect/migration/fit/faq)

## 2. ユーザーアカウントの Google 統合

- **2026/05/19** 以降、従来の Fitbit アカウントでのログイン不可
- 未統合ユーザーは **2026/07/15** にデータ削除(それまでは export 可能)
- 開発者アカウントも同様に Google Account 移行必須
- 期限は何度か延期されてきた経緯あり、さらなる延長の可能性は要観測

出典:
- [Fitbit extends Google Account deadline to May 2026 - 9to5Google](https://9to5google.com/2026/01/31/fitbit-google-account-may-2026-deadline/)
- [How to move your Fitbit Account to a Google Account - Google Help](https://support.google.com/fitbit/answer/14237024?hl=en)
- [Fitbit users risk losing data by 2026 - Android Central](https://www.androidcentral.com/wearables/fitbit/fitbit-google-account-merge-deadline-change-data-deletion)

## 3. OAuth 2.0(PKCE、スコープ、トークン)

### 推奨フロー
- **Authorization Code Grant + PKCE(RFC 7636)**。現代実装では PKCE は必須扱い
- Client Credentials は Application レベルのデータのみ、健康データには使えない

### App タイプ

| タイプ | 用途 | Intraday | Secret |
|---|---|---|---|
| **Personal** | 自分のデータ | **申請不要で即利用可** | Client ID + Secret(PKCE 推奨) |
| Server | サーバー側で多ユーザー | 申請必要 | Basic Auth 必須 |
| Client | モバイル/SPA | 個別審査 | PKCE |

Token エンドポイント(`/oauth2/token`)は Server App では `Authorization: Basic base64(client_id:client_secret)` を要求。

### スコープ(Web API)
`activity`, `cardio_fitness`, `electrocardiogram`, `heartrate`, `location`, `nutrition`, `oxygen_saturation`, `profile`, `respiratory_rate`, `settings`, `sleep`, `social`, `temperature`, `weight`

### トークンの扱い
- **access_token 寿命 8 時間**(28800 秒)、期限切れで HTTP 401
- **refresh_token は 1 回限り使用可**(使うと新ペアが返る、古いのは破棄)
- 同意撤回されない限り access は維持できる
- **2 分以内の同一 refresh_token リクエストは同じレスポンスを返す**(並行プロセスの二重 refresh 対策)

### Callback URL 要件
- 本番は HTTPS 必須
- `http://localhost` と `http://127.0.0.1` は HTTP 許可(ローカル開発用)
- Scheme、末尾スラッシュまで厳密一致(`invalid_request` の頻出原因)
- カスタムスキーム(`myapp://callback`)も可

出典:
- [Fitbit OAuth 2.0 Tutorial](https://dev.fitbit.com/build/reference/web-api/troubleshooting-guide/oauth2-tutorial/)
- [Fitbit Authorization](https://dev.fitbit.com/build/reference/web-api/developer-guide/authorization/)
- [Fitbit Application Design](https://dev.fitbit.com/build/reference/web-api/developer-guide/application-design/)
- [Fitbit Refresh Token](https://dev.fitbit.com/build/reference/web-api/authorization/refresh-token/)
- [Intraday data now immediately available to personal apps](https://community.fitbit.com/t5/Web-API-Development/Intraday-data-now-immediately-available-to-personal-apps/td-p/1014524)

## 4. 取得できるデータの網羅

ベース URL: `https://api.fitbit.com`

### Activity
- `GET /1/user/-/activities/date/{date}.json` — Daily Activity Summary
- `GET /1/user/-/activities/goals/{period}.json` — Activity Goals
- `GET /1/user/-/activities/{resource}/date/{date}/{period}.json` — Time Series
- `GET /1/user/-/activities/list.json` — Exercise log list
- `POST /1/user/-/activities.json` — Create Activity Log(activityId または activityName + manualCalories)
- `DELETE /1/user/-/activities/{activity-log-id}.json`

### Heart Rate
- `GET /1/user/-/activities/heart/date/{date}/{period}.json`
- **Intraday**: `GET /1/user/-/activities/heart/date/{date}/1d/{detail-level}.json`(`1sec`/`1min`/`5min`/`15min`)
- `1sec` は運動記録中以外、1 秒粒度が保証されないことあり

### Sleep(v1.2 を使う、v1 は deprecated)
- `GET /1.2/user/-/sleep/date/{date}.json`
- `GET /1.2/user/-/sleep/date/{base}/{end}.json`
- `GET /1.2/user/-/sleep/list.json`
- `POST /1.2/user/-/sleep.json`
- Stages(30 秒粒度 deep/light/rem/wake)と Classic(60 秒粒度)の 2 種類

### Body
- `GET /1/user/-/body/log/weight/date/{date}.json`
- `POST /1/user/-/body/log/weight.json`(BMI 自動計算)
- `GET /1/user/-/body/log/fat/date/{date}.json`
- `POST /1/user/-/body/log/fat.json`

### Nutrition
- `GET /1/user/-/foods/log/date/{date}.json`
- `POST /1/user/-/foods/log.json`(5 節参照)
- `POST /1/user/-/foods.json`(カスタム食品作成)
- `DELETE /1/user/-/foods/log/{log-id}.json`
- `GET /1/foods/search.json?query=...`
- `POST /1/user/-/foods/log/water.json?date=YYYY-MM-DD&amount=12&unit=fl%20oz`

### 新しめのメトリクス
- SpO2: `GET /1/user/-/spo2/date/{date}.json`(scope `oxygen_saturation`)
- 呼吸数: `GET /1/user/-/br/date/{date}.json`(`respiratory_rate`)
- 皮膚温: `GET /1/user/-/temp/skin/date/{date}.json`(`temperature`)
- ECG: `GET /1/user/-/ecg/list.json`(`electrocardiogram`)
- HRV: `GET /1/user/-/hrv/date/{date}.json`(`heartrate`)
- Cardio Fitness(VO2 Max): `GET /1/user/-/cardioscore/date/{date}.json`(`cardio_fitness`)

### Device
- `GET /1/user/-/devices.json`(battery, batteryLevel, lastSyncTime, deviceVersion, mac, type)

### Subscription(Webhook)
- エンドポイントを HTTPS 公開 → 検証コード応答 → activate
- 応答要件: **5 秒以内に HTTP 204**
- ペイロード署名検証に Client Secret を使用

出典:
- [Fitbit Web API Reference](https://dev.fitbit.com/build/reference/web-api/)
- [Swagger UI](https://dev.fitbit.com/build/reference/web-api/explore/)
- [Heart Rate Intraday](https://dev.fitbit.com/build/reference/web-api/intraday/get-heartrate-intraday-by-date/)
- [Sleep Logs](https://dev.fitbit.com/build/reference/web-api/sleep/)
- [Cardio Fitness Score](https://dev.fitbit.com/build/reference/web-api/cardio-fitness-score/)
- [7 New Data Types](https://dev.fitbit.com/blog/2022-12-06-announcing-new-data-types/)
- [Using Subscriptions](https://dev.fitbit.com/build/reference/web-api/developer-guide/using-subscriptions/)

## 5. 食事ログ書き込みの実情

### `POST /1/user/-/foods/log.json`

| フィールド | 必須 | 説明 |
|---|---|---|
| `foodId` | `foodName` と排他 | Fitbit DB の food の ID |
| `foodName` | `foodId` と排他 | カスタム名(DB に無いもの) |
| `mealTypeId` | ○ | 1=Breakfast, 2=Morning Snack, 3=Lunch, 4=Afternoon Snack, 5=Dinner, 7=Anytime |
| `unitId` | foodId 時 ○ | Fitbit の単位 ID |
| `amount` | ○ | 量 |
| `date` | ○ | YYYY-MM-DD |
| `calories` | foodName 時 ○ | kcal |
| `brandName` | - | - |
| `nutritionalValues` | - | totalFat, sugar, sodium 等を個別フィールドで |

`foodId` と `foodName` の両方指定はエラー。

### Custom Food と mealTypeId
Create Food で作ったカスタム食品は mealTypeId が常に 7(Anytime)として保存される、という記述がドキュメントにある。一方で `foodName` 直接指定では mealType が効くという community 報告もあり、実装時は実機検証が必要。

### 日本食
- `GET /1/foods/search.json` は米国英語 DB が最も充実、regional food は弱い
- `foodDatabase` パラメータで locale 指定可能(`GET /1/foods/locales.json`)
- **日本食は精度が低い**。`foodName` + `calories` + 栄養素指定で直接 log するのが現実解

### 画像認識
- **Fitbit API 側に画像→食事認識は無い**(アプリのバーコードスキャンは API 非公開)
- 画像認識が必要なら外部(FatSecret、LogMeal、Vision LLM 等)に任せ、結果を `foodName` + `calories` で書き込む

### 既知障害(2025/11 〜)
- **2025/11/07 頃から Food Log の部分障害**(Fitbit アプリで food search/barcode 不可、Frequent/Recent/Custom のみ機能)
- **2025/12 にログエントリ消失障害**
- API から `POST foods/log` の `foodName` 指定書き込みは動いている模様だが、**Search Foods 経由のフローは代替を用意**

出典:
- [Create Food Log](https://dev.fitbit.com/build/reference/web-api/nutrition/create-food-log/)
- [Food Logging Overview](https://dev.fitbit.com/build/reference/web-api/food-logging/)
- [Search Foods](https://dev.fitbit.com/build/reference/web-api/nutrition/search-foods/)
- [Create Food](https://dev.fitbit.com/build/reference/web-api/nutrition/create-food/)
- [Fitbit's food log is broken in widespread partial outage - 9to5Google](https://9to5google.com/2025/11/07/fitbit-food-log-outage/)
- [Fitbit investigating disappearing meal entries - PiunikaWeb](https://piunikaweb.com/2025/12/05/fitbit-investigating-disappearing-meal-entries/)
- [Nutrition log: loggedFood changed unexpectedly to logged_food](https://community.fitbit.com/t5/Web-API-Development/Nutrition-log-loggedFood-changed-unexpectedly-to-logged-food/td-p/5772376)

## 6. レート制限

- **ユーザー毎 150 リクエスト/時**、毎時 00 分でリセット(スライディングウィンドウではない)
- ユーザー単位なのでアプリ全体で複数ユーザーを扱っても個別枠
- HTTP 429 + `Retry-After` ヘッダ
- レスポンスに `fitbit-rate-limit-limit` / `fitbit-rate-limit-remaining` / `fitbit-rate-limit-reset` が含まれる
- LLM が連続呼び出しする MCP では **キャッシュ必須**(TTL 1h 推奨)

出典:
- [Fitbit API Rate Limit Issue](https://community.fitbit.com/t5/Web-API-Development/Fitbit-API-Rate-Limit-Issue/td-p/5733548)
- [How do API rate limits work?](https://community.fitbit.com/t5/Web-API-Development/How-do-API-rate-limits-work/td-p/324370)

## 7. Intraday の条件

- **Personal App は申請フォーム不要**、自分の Intraday に即アクセス可
- Server / Client App で他ユーザーの Intraday を取るにはフォーム申請 → レビュー(非営利・個人プロジェクトには好意的)

出典:
- [Intraday data now immediately available to personal apps](https://community.fitbit.com/t5/Web-API-Development/Intraday-data-now-immediately-available-to-personal-apps/td-p/1014524)

## 8. MCP TypeScript SDK と Streamable HTTP

### SDK
- **`@modelcontextprotocol/sdk@^1.29`**(2026/04 時点)。v2 は pre-alpha(Q1 2026 予定)
- 新規コードには `McpServer` + `registerTool` / `registerPrompt` / `registerResource` が推奨
- **Standard Schema 対応済**(Zod v4, Valibot, ArkType 等)。Zod は peerDependencies から外れて内部依存に
- Tool 返却フォーマット: `content: [{ type: "text"|"image"|"audio"|... }]` + `structuredContent`(2025-06-18 以降の推奨)

### トランスポート(2026/04 時点)

| 種類 | 状態 | 用途 |
|---|---|---|
| **stdio** | 現役 | ローカル Claude Desktop / Claude Code |
| **Streamable HTTP** | 現役・標準 | クラウドホスト、Claude モバイル / claude.ai は全てこれ |
| HTTP+SSE(旧) | Deprecated | 後方互換のみ |

- **2025-03-26** 仕様で Streamable HTTP 導入、SSE deprecated
- **2025-06-18** 仕様で Streamable HTTP を正式標準化
- 主要ホスト(Atlassian, Keboola など)は 2025 Q3〜Q4 に SSE エンドポイント閉鎖

### Streamable HTTP の性質
- 単一エンドポイント(`POST` と `GET` 両対応)
- `Accept` ヘッダには `application/json` と `text/event-stream` の両方を含める
- セッション管理は任意(`Mcp-Session-Id` ヘッダ)
- `MCP-Protocol-Version: 2025-06-18` 必須
- セキュリティ: `Origin` 検証必須、ローカル実行は `127.0.0.1` バインド推奨

出典:
- [MCP Specification 2025-06-18 - Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [One Year of MCP](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)
- [Why MCP Deprecated SSE and Went with Streamable HTTP](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [typescript-sdk server.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [simpleStatelessStreamableHttp.ts](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts)

## 9. Claude モバイルの MCP 接続経路

### 対応時期
- **2025-07-26**: Claude iOS/Android で Remote MCP サポート正式リリース
- 2026-01: MCP Apps(インタラクティブ UI)launch

### 設定可能なトランスポート
- **Streamable HTTP のみ**(+ 後方互換で HTTP+SSE)
- **stdio は物理的に不可能**(iOS/Android サンドボックスでサブプロセス起動不可)

### 設定場所
- **Claude.ai Web UI** の Settings → Connectors → "Add Custom Connector" で追加
- Mobile / Desktop / Web に自動同期
- **モバイル単独で新規コネクタ追加は不可**。モバイルは会話ごとの ON/OFF トグルのみ

### 接続経路(超重要)
- Claude クライアント(モバイル/Desktop/Web すべて)は **直接接続しない**
- **Anthropic のクラウドが MCP サーバーに接続**する
- MCP サーバーは **公開インターネットから Anthropic の IP レンジで到達可能**である必要
- Anthropic outbound CIDR: **`160.79.104.0/21`**(2,048 IP、IPv4)
- VPN 内、社内 FW 内、localhost のみリッスンのサーバーは **繋がらない**

### ローカル MCP をモバイルから使うには
| 選択肢 | 特徴 |
|---|---|
| **Cloudflare Tunnel (named tunnel)** | 無料、固定 URL、バックグラウンド常駐容易 |
| Cloudflare Quick Tunnel | ワンコマンド、URL 変動 |
| ngrok | 5 分で動くが無料は random subdomain |
| Tailscale Funnel | tailnet 必要 |
| **Cloudflare Workers にデプロイ** | PC 常時起動不要、一番楽 |

### 初回 OAuth
MCP コネクタをトグル ON 時、内蔵ブラウザが OAuth 認可画面に遷移。承認後トークンは Anthropic 側で管理、全プラットフォームで共有。

**ただし Google OAuth は WebView をブロック**する(`disallowed_useragent`)ので、Claude 内蔵ブラウザ経由で認可が落ちる可能性あり。Fitbit の Google 統合済みユーザーはここで詰まりうる。**個人利用なら CLI で事前取得してモバイル側で OAuth を踏まない方式が最も堅実**。

出典:
- [Claude Integrations announcement](https://claude.com/blog/integrations)
- [Claude Android app](https://claude.com/blog/android-app)
- [Interactive connectors and MCP Apps](https://claude.com/blog/interactive-tools-in-claude)
- [Build custom connectors via remote MCP servers](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers)
- [How to Set Up Remote MCP on Claude iOS/Android](https://dev.to/zhizhiarv/how-to-set-up-remote-mcp-on-claude-iosandroid-mobile-apps-3ce3)
- [Anthropic IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)
- [The Missing MCP Playbook](https://medium.com/@george.vetticaden/the-missing-mcp-playbook-deploying-custom-agents-on-claude-ai-and-claude-mobile-05274f60a970)

## 10. 画像を Claude モバイル → MCP で扱う方法

### Claude モバイルに画像を添付した場合の挙動
- ユーザーが食事写真を添付すると、**Claude モデル自身がビジョン入力として受け取り解析**
- MCP サーバーは(現状)画像生データを受け取らない

### MCP Tool の入力として画像を直接渡せるか
- **MCP inputSchema は JSON Schema**(string/number/object/array)、バイナリ専用型なし
- base64 encoded 文字列として渡すことは技術的には可能だが、Claude は通常そうしない(トークン浪費)
- 「画像のやり取りを MCP で標準化する方法」はまだ議論中(discussion #1204, #794)

### 本命パターン: 「Claude が視覚解析 → JSON 化 → MCP Tool 呼び出し」
Anthropic Cookbook の "Using vision with tools" パターンそのまま。Tool の `inputSchema` をリッチに設計するのが肝。

```ts
inputSchema: {
  mealType: z.enum(["Breakfast", "Lunch", "Dinner", "Snack"]),
  date: z.string().describe("YYYY-MM-DD, default today"),
  items: z.array(z.object({
    name: z.string(),
    estimatedGrams: z.number(),
    calories: z.number(),
    protein: z.number().optional(),
    carbs: z.number().optional(),
    fat: z.number().optional(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
  notes: z.string().optional(),
}
```

MCP サーバーは画像を一切扱わず、構造化された `items[]` を受けるだけのシンプル API。

出典:
- [Anthropic Cookbook: Using vision with tools](https://platform.claude.com/cookbook/tool-use-vision-with-tools)
- [MCP discussion #1204](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1204)

## 11. Remote MCP での OAuth の設計パターン

### MCP 仕様の認可(2025-06-18 / 2025-11-25)
- MCP サーバーは OAuth 2.1 Resource Server として振る舞う
- 必須実装:
  - `/.well-known/oauth-protected-resource`(RFC 9728)
  - `/.well-known/oauth-authorization-server`(RFC 8414)
- 推奨: **Dynamic Client Registration(RFC 7591)** — Claude.ai は対応済

### パターン A: MCP が OAuth プロキシ(Cloudflare `workers-oauth-provider`)
- MCP サーバー自身が OAuth 2.1 AS として振る舞い、裏で別プロバイダ(Fitbit, GitHub, Auth0, ...)に委譲
- RFC 8414 / 9728 / 7591 自動提供、Worker 側コードは「認証済ユーザー情報を受け取る fetch handler」だけでよい
- 他人にも配布したい用途に最適、実装量は 2〜3 倍

### パターン B: CLI 事前取得、サーバーは ENV/KV のトークン参照だけ(個人利用最速)
- CLI で 1 回だけ Fitbit OAuth を踏み、access/refresh を KV/ファイルに保存
- MCP サーバーは起動時/リクエスト時にこれを読むだけ
- Claude.ai からは「OAuth なし」で登録、URL を推測不能にして保護
- 実装量が圧倒的に少ない
- **Google OAuth の WebView ブロック問題も回避**(PC システムブラウザで 1 回踏むだけ)

### パターン C: ハイブリッド
- パターン B + MCP エンドポイントに shared secret(URL 埋め込み + Anthropic CIDR allowlist)

出典:
- [MCP Specification 2025-06-18 - Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [Build and deploy Remote MCP servers to Cloudflare](https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/)
- [Cloudflare Agents - Authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)

## 12. 先行実装サーベイ

### Fitbit 向け MCP サーバー

| リポジトリ | 言語 | Tools | OAuth | Write | 備考 |
|---|---|---|---|---|---|
| **[TheDigitalNinja/mcp-fitbit](https://github.com/TheDigitalNinja/mcp-fitbit)** | TS | **12** | ローカル callback port 3000 | **無し** | 事実上の標準、npm 公開 `mcp-fitbit`、MIT |
| [NitayRabi/fitbit-mcp](https://github.com/NitayRabi/fitbit-mcp) | TS | 7 | ENV 注入 | 無し | 薄い |
| [Async-IO/pierre_mcp_server](https://github.com/Async-IO/pierre_mcp_server) | Rust | 47+ | OAuth2 AS 兼 | 一部 | 大規模、Fitbit 含む複数スポーツサービス |

TheDigitalNinja 版の read 系 12 ツール: `get_weight` / `get_sleep_by_date_range` / `get_exercises` / `get_daily_activity_summary` / `get_activity_goals` / `get_activity_timeseries` / `get_azm_timeseries` / `get_heart_rate` / `get_food_log` / `get_profile` など。書き込み系は未対応を README で言及。

### Node/TS 向け Fitbit API クライアント OSS
- `fitbit-node`(lukasolson): v2.2.0、**7 年メンテ停止**、型なし
- `fitbit-client-oauth2`, `fitbit-oauth2-client`, `p-m-p/node-fitbit`, `fitbit-api-handler`, `@researchable/fitbit-web-api`: 軒並み更新停止
- `passport-fitbit-oauth2`: Express 向けストラテジ
- **結論: 既存 SDK は使わず、`fetch` + `zod` で自前実装が現実解**

### 他の健康系 MCP(設計参考)
- **Garmin**: Taxuspt/garmin_mcp(96+ ツール、1 API=1 ツール)、Nicolasvegam(61)、eddmann(22)
- **Oura**: tomekkorbak(シンプル)、vsaarinen/oura-api-mcp(MCP 公式 TS SDK)
- **WHOOP**: [nissand/whoop-mcp-server-claude](https://github.com/nissand/whoop-mcp-server-claude)(TS、綺麗なファイル分割)、RomanEvstigneev(AES トークン暗号化)
- **Strava**: r-huijts(25)、eddmann(11×5 カテゴリ)、[kw510/strava-mcp](https://github.com/kw510/strava-mcp)(**Cloudflare Workers Remote MCP**)、[gcoombe/strava-mcp](https://github.com/gcoombe/strava-mcp)(OAuth/API/HTTP/MCP の 4 レイヤ分割、JWT マルチユーザー)
- **Apple Health**: the-momentum(DuckDB、1000+ stars)、neiltron(SQL)

**ツール粒度の設計観**: 12〜20 ツールが LLM の選択コストとカバレッジのバランスで最適。Fitbit 規模なら 16〜24 程度。

## 13. デプロイ先の選択肢

| 先 | 強み | 弱み | 個人利用 |
|---|---|---|---|
| **Cloudflare Workers** | Edge、ほぼ無料、workers-oauth-provider、KV/D1、cold start 極小 | Node API 一部不可 | ★★★(推奨) |
| Fly.io | `fly mcp launch`、per-second、auto-suspend | 永続ストレージ別途 | 簡単 |
| Railway | 常時起動、Redis ワンクリック、$5/mo | 割高 | 楽だが割高 |
| Render | 予測しやすい、無料は 15 min sleep | Free は本番向かず | 中規模向け |
| Vercel Functions | Next.js と同居可、Fluid Compute | 関数時間制限 | Next.js 同居なら |
| **ローカル + Cloudflare Tunnel** | 無料、完全コントロール | PC 常時起動必要 | 自宅サーバー派 |

本プロジェクトは **Cloudflare Workers** を採用。

出典:
- [Deploy MCP Servers: Vercel vs Railway vs Render vs Heroku vs Fly.io (2026)](https://mcpplaygroundonline.com/blog/deploy-mcp-server-vercel-railway-render-heroku-flyio)
- [Build a Remote MCP server - Cloudflare](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)
- [Koyeb - Deploy Remote MCP Servers with Streamable HTTP](https://www.koyeb.com/tutorials/deploy-remote-mcp-servers-to-koyeb-using-streamable-http-transport)

## 14. まとめ: 本プロジェクトが採った設計

| 観点 | 選択 | 理由 |
|---|---|---|
| Runtime | Cloudflare Workers | モバイル対応、無料、常時稼働 |
| Transport | Streamable HTTP(stateless) | モバイル利用に必須 |
| SDK | `@modelcontextprotocol/sdk@^1.29` + `McpServer` + `registerTool` | 現行推奨 |
| Validation | Zod v4 | SDK Standard Schema 対応 |
| Provider 抽象 | `HealthProvider` インターフェース | 2026/09 の Google Health 移行に備える |
| OAuth | Pattern B(CLI 事前取得 + KV 保存) | Google OAuth の WebView 問題回避、実装最小、個人利用に最適 |
| Endpoint 保護 | SECRET(URL 埋め込み)+ Anthropic CIDR `160.79.104.0/21` allowlist | 個人利用のコストパフォーマンス最大 |
| Food logging | `foodName` + `calories` 直接書き込み | 日本食対応 + 2025/11 Food Log 障害回避 |
| Sleep | v1.2 | v1 deprecated |
| 画像 | MCP サーバーは画像を扱わない。Claude 視覚解析 → `items[]` | 本命パターン、トークン効率良し |
| Public | MIT OSS | fork して各自デプロイできる形を目指す |

---

# 主要参考 URL(アルファベット順・抜粋)

- [Anthropic IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)
- [Anthropic Cookbook: vision with tools](https://platform.claude.com/cookbook/tool-use-vision-with-tools)
- [Build a Remote MCP server (Cloudflare)](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)
- [Cloudflare workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [Claude Integrations announcement](https://claude.com/blog/integrations)
- [Claude Android app](https://claude.com/blog/android-app)
- [Fitbit Web API Reference](https://dev.fitbit.com/build/reference/web-api/)
- [Fitbit OAuth 2.0 Tutorial](https://dev.fitbit.com/build/reference/web-api/troubleshooting-guide/oauth2-tutorial/)
- [Fitbit Create Food Log](https://dev.fitbit.com/build/reference/web-api/nutrition/create-food-log/)
- [Fitbit Status Dashboard](https://status.fitbit.com/)
- [Fitbit API Deprecation - Thryve](https://www.thryve.health/blog/fitbit-api-deprecation)
- [Google Health API - About](https://developers.google.com/health/about)
- [Google Health API - Migration guide](https://developers.google.com/health/migration)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [TheDigitalNinja/mcp-fitbit](https://github.com/TheDigitalNinja/mcp-fitbit)
- [Why MCP Deprecated SSE (fka.dev)](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
