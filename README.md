# fitbit-googlehealth-mcp

> Fitbit の広範なヘルスデータを取得し、食事写真から食事ログを書き込める **Model Context Protocol (MCP) サーバー**。TypeScript 実装、Cloudflare Workers にデプロイ。Claude モバイル / Claude Desktop / Claude.ai から接続して使えます。

個人利用前提の設計で、fork してあなた自身の Fitbit アプリ + Cloudflare アカウントで独立運用できます。

## 何ができる

- **Fitbit データの取得**(Read tool 16 個)
  - Activity(歩数・距離・カロリー・運動ログ)
  - Heart Rate(日別 + 1秒〜15分の Intraday)
  - Sleep v1.2(stage 含む)
  - Body(体重・体脂肪・BMI)
  - Nutrition(食事ログ・水分)
  - SpO2 / 呼吸数 / 皮膚温 / HRV / VO2 Max
  - デバイス情報
- **書き込み**(Write tool 8 個)
  - 食事(`log_food`・日本語 OK)
  - 水分・体重・体脂肪・活動・睡眠の手動ログ
  - `delete_food_log` で個別エントリ取り消し
- **⭐ `log_meal_photo`**: Claude モバイルで食事写真を添付 → Claude が視覚解析して栄養を推定 → 一括で Fitbit 食事ログに記録

---

## ⚠ 2026/09 の Fitbit Web API 停止について

Fitbit は **2026 年 9 月**に既存の Web API(`api.fitbit.com`)を完全停止し、後継の [Google Health API](https://developers.google.com/health)(`health.googleapis.com/v4`)に移行します。

- 既存の Fitbit OAuth トークンは **移行不可** → Google OAuth で再同意が必要
- あわせて、Fitbit アカウント自体を **2026/05/19 までに Google Account に統合**必要(未統合は 2026/07/15 にデータ削除)
- 本実装は **Provider-agnostic 設計** を採っており、停止前に Google Health API 実装(`src/providers/google-health/`)を追加して差し替え予定

詳細は [`docs/research.md`](docs/research.md) を参照。

---

## 前提

- **Fitbit アカウント**(Google Account と統合済みが望ましい)
- **Fitbit Personal App**(dev.fitbit.com で作成、callback `http://127.0.0.1:8787/fitbit/callback`)
- **Cloudflare アカウント**(無料プランで十分)
- **Claude.ai アカウント**(Web から Custom Connector を追加、モバイルに自動同期)
- **Node.js 20+ / pnpm 9+**(ローカルビルド用)

---

## セットアップ(5 ステップ)

### 1. Clone + install

```bash
git clone https://github.com/tachibanayu24/fitbit-googlehealth-mcp.git
cd fitbit-googlehealth-mcp
pnpm install
```

### 2. Fitbit Personal App 作成

[dev.fitbit.com/apps/new](https://dev.fitbit.com/apps/new) で **Personal** タイプのアプリを作成:
- **OAuth 2.0 Application Type**: Personal
- **Callback URL**: `http://127.0.0.1:8787/fitbit/callback`

発行された `Client ID` と `Client Secret` を控える。

### 3. 初回認可と Cloudflare への投入

```bash
# 認可フローを開始(ブラウザが開く)
export FITBIT_CLIENT_ID=<your-client-id>
export FITBIT_CLIENT_SECRET=<your-client-secret>
pnpm run setup:fitbit
```

ブラウザで承認すると refresh_token が取れて、以降表示される `wrangler secret put` / `wrangler kv key put` コマンドをコピペして実行:

```bash
# wrangler.toml は .gitignore 対象。テンプレからコピーして自分の値を入れる
cp wrangler.toml.example wrangler.toml

# KV namespace(一回きり)
pnpm wrangler kv namespace create TOKENS
pnpm wrangler kv namespace create CACHE
# 返ってきた id を wrangler.toml の <your-...-id> に貼り付け

# Secret(MCP_SHARED_SECRET は URL-safe な hex を推奨)
pnpm wrangler secret put FITBIT_CLIENT_ID
pnpm wrangler secret put FITBIT_CLIENT_SECRET
openssl rand -hex 32 | pnpm wrangler secret put MCP_SHARED_SECRET

# Fitbit トークン(setup:fitbit の出力をそのままコピペ、--remote 重要)
pnpm wrangler kv key put --remote --binding=TOKENS refresh_token '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS access_token  '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS expires_at    '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS user_id       '<paste>'
```

### 4. デプロイ

```bash
pnpm deploy
# → https://fitbit-googlehealth-mcp.<your-sub>.workers.dev
```

### 5. Claude.ai に Custom Connector として登録

1. [claude.ai](https://claude.ai) で Settings → Connectors → **Add Custom Connector**
2. URL に `https://fitbit-googlehealth-mcp.<your-sub>.workers.dev/mcp/<MCP_SHARED_SECRET>` を貼る
3. 認証方式は **OAuth なし**(URL に secret を埋め込んでいるため)
4. 保存すると Claude モバイル / Desktop / Web に自動同期される

モバイルで新規会話を開き、`+` → Connectors → **Fitbit** を ON にして完了。

---

## ツール一覧

### Read(16)

| Tool | 引数 | 概要 |
|---|---|---|
| `get_profile` | — | プロフィール(単位系・身長・タイムゾーン) |
| `list_devices` | — | デバイス一覧(バッテリ、最終同期時刻) |
| `get_daily_summary` | `date?` | 歩数・カロリー・心拍ゾーン・active minutes |
| `get_activity_timeseries` | `resource, start, end` | steps / distance / calories 等の時系列 |
| `get_exercise_list` | `beforeDate?, limit?` | 運動ログ履歴 |
| `get_heart_rate_range` | `start, end` | 日別心拍(resting + zones) |
| `get_heart_rate_intraday` | `date, detailLevel` | Intraday(1sec/1min/5min/15min) |
| `get_sleep` | `date?` | Sleep v1.2(stage 含む) |
| `get_sleep_range` | `start, end` | 期間 Sleep |
| `get_body_log` | `start, end` | 体重 + 体脂肪 |
| `get_food_log` | `date?` | 食事ログ + 水分 + 栄養サマリ |
| `get_spo2` | `start, end` | 血中酸素飽和度 |
| `get_respiratory_rate` | `start, end` | 呼吸数 |
| `get_skin_temperature` | `start, end` | 皮膚温(nightly relative) |
| `get_hrv` | `start, end` | HRV(RMSSD) |
| `get_cardio_fitness` | `date?` | Cardio Fitness Score(VO2 Max) |

### Write(7)

| Tool | 引数 | 概要 |
|---|---|---|
| `log_food` | `foodName, calories, mealType, date?, nutritionalValues?` | 食事を 1 件記録(日本語 OK、PFC 保持) |
| `log_meal_photo` | `mealType, items[], date?, notes?` | **写真解析結果を一括で記録**(Claude が視覚解析 → items を渡す前提) |
| `log_water` | `amountMl, date?` | 水分(ml) |
| `log_weight` | `weightKg, date?, time?` | 体重 |
| `log_body_fat` | `fatPercent, date?, time?` | 体脂肪率 |
| `log_activity` | `activityId or activityName+manualCalories, startTime, durationMs, date?, distanceKm?` | 手動で運動ログ |
| `log_sleep` | `startTime, durationMs, date?` | 手動で睡眠ログ |

### Delete(6)

| Tool | 引数 | 概要 |
|---|---|---|
| `delete_food_log` | `logId, date?` | 食事エントリ削除 |
| `delete_water_log` | `logId, date?` | 水分エントリ削除 |
| `delete_weight_log` | `logId, date?` | 体重エントリ削除 |
| `delete_body_fat_log` | `logId` | 体脂肪エントリ削除 |
| `delete_activity_log` | `logId, date?` | 運動ログ削除 |
| `delete_sleep_log` | `logId, date?` | 睡眠ログ削除 |

### Meal preset(4)

作り置き用の再利用可能な栄養プロファイルを MCP サーバー側(Workers KV)に保存して、ログ時に栄養素込みで Fitbit へ投入する仕組み。Fitbit の Create Food API は栄養素を保存しない仕様なので、PFC 追跡にはこちらを使う。

| Tool | 引数 | 概要 |
|---|---|---|
| `save_meal_preset` | `name, calories, protein?, carbs?, fat?, fiber?, sodium?, sugar?, notes?` | preset を保存(同名で上書き) |
| `list_meal_presets` | — | 保存済み preset 一覧 |
| `log_preset` | `name, mealType, date?, amount?` | preset を今日/指定日の食事ログに記録 |
| `delete_meal_preset` | `name` | preset 削除(既存 log には影響なし) |

全 `date?` は省略時 **JST の今日** にフォールバック。Tool 総数 33(Read 16 + Write 7 + Delete 6 + Preset 4)。

---

## 使用例

### 写真で食事記録
> 🤳 モバイルで昼食の写真を添付  
> 🧑 「これを lunch で記録して」  
> 🤖 Claude が視覚解析 → `log_meal_photo` を呼ぶ  
>
> ```
> Logged 3 item(s) for Lunch on 2026-04-22:
>   • 親子丼(1人前、推定 680 kcal、高信頼度)
>   • 味噌汁(1杯、推定 40 kcal、中信頼度)
>   • 小鉢(ほうれん草、推定 60 kcal、中信頼度)
> ```

### 睡眠の分析
> 🧑 「昨日の睡眠を見せて」  
> 🤖 Claude が `get_sleep` を呼び、stage の内訳や minutesAsleep / efficiency を要約

### 活動トレンド
> 🧑 「先週の歩数どうだった?」  
> 🤖 `get_activity_timeseries(resource: "steps", start: ..., end: ...)` → 週平均・目標達成率を計算

---

## ローカル開発

```bash
# ローカルで Worker 起動(local KV、local secret)
echo 'MCP_SHARED_SECRET=dev-secret' > .dev.vars
pnpm dev

# Lint / Format / Typecheck / Test
pnpm lint
pnpm format
pnpm typecheck
pnpm test

# MCP Inspector で tool schema 確認
npx @modelcontextprotocol/inspector
# URL: http://127.0.0.1:8787/mcp/dev-secret
# CF-Connecting-IP ヘッダで 160.79.104.5 を送る設定が必要
```

---

## アーキテクチャ

```
Claude mobile / Desktop / Web
      │ (public URL: Streamable HTTP)
      ▼
Anthropic Cloud  (outbound CIDR 160.79.104.0/21)
      │
      ▼
Cloudflare Workers  /mcp/<SECRET>
  ├─ guard middleware  (SECRET + CIDR allowlist)
  ├─ @hono/mcp  Streamable HTTP transport
  └─ McpServer
       ├─ HealthProvider interface
       │   └─ FitbitProvider
       │       ├─ OAuth refresh (Workers KV: TOKENS)
       │       └─ FitbitClient (fetch wrapper, 401/429 retry)
       └─ tools/read/*, tools/write/*
            └─ getCached → Workers KV: CACHE  (TTL 1h)
```

- **Provider 抽象**: 2026/09 以降、`GoogleHealthProvider` に差し替えて継続運用
- **Cache**: Read 結果を KV に 1h キャッシュ、Fitbit の 150/h/user 制限を温存
- **画像は MCP サーバーを通らない**: Claude が視覚解析して `items[]` を引数として渡す

---

## セキュリティ

**個人用シンプル認証** の構成です。

- **SECRET + Anthropic CIDR の 2 層防御**:
  1. URL パス末尾の `<MCP_SHARED_SECRET>` が一致しなければ 401(constant-time 比較)
  2. `CF-Connecting-IP` が `ALLOWED_CIDRS` env の CIDR のいずれにも属さなければ 403
- Anthropic outbound CIDR は公開情報 `160.79.104.0/21`。claude.ai 経由のリクエストだけを通す
- `MCP_SHARED_SECRET` は Workers Secret に保管、コードには入れない
- ローテーションは `wrangler secret put` + claude.ai の URL 更新だけで完結。Fitbit トークンに影響なし

**脅威モデル**: SECRET が漏れて攻撃者が Anthropic CIDR 内からアクセスできる場合のみ、あなたの Fitbit データ閲覧・偽書き込みが可能。Fitbit アカウント自体の乗っ取りは不可(refresh_token は Worker 内にのみ存在)。

複数ユーザー配布が必要なら `@cloudflare/workers-oauth-provider` で本格 OAuth AS 化する方針に切り替え可能(本リポはそれを選んでいない — 個人用最小構成)。

---

## 既知の制約(Fitbit API 側の仕様、本実装で対処済みのもの)

### 食事ログ周り
- **Search Foods 障害(2025/11〜)**: Fitbit 公式 API の `/foods/search` が不安定。本実装は意図的に `foodName` + `calories` 直書きしか使わない
- **`POST /foods/log.json` は `unitId` を必須化**(`unitName` は受け付けない)。本実装は foodName モードで `unitId: 304` (= serving) を自動付与
- **栄養素キー名が非対称**(実測結果、2026-04):
  - `protein` / `totalFat` / `totalCarbohydrate` / `dietaryFiber` / `sodium` / `sugars` — これらのキー名で送らないと Fitbit 側で無視される
  - 旧 docs の `nutritionalValues.protein` 形式も、`proteinGrams` / `totalCarbs` 等も 2026-04 時点では効かない
- **Create Food(カスタム食品)は calories のみ保存**:protein/carbs/fat を送っても silent drop される。本実装は `create_custom_food` を廃止し、栄養素を保持したい場合は **MCP サーバー側プリセット**(`save_meal_preset` + `log_preset`)で foodName 経路に流している
- **sugar は `get_food_log` の echo に含まれない** — 保存されたかは視認できない

### Intraday(心拍数)
- **運動ログがある日は Fitbit が intraday の dataset を pruning**することがある(実測:運動日は朝〜夕方の dataset が欠落、運動無しの日は終日揃う)。zone summary は別パイプラインで残るので `get_heart_rate_range` はフォールバックに使える
- **1sec 粒度**:運動記録中以外は 1 秒粒度が保証されない

### その他
- **Sleep は v1.2 のみ**(v1 は deprecated)
- **Claude モバイルから Custom Connector の新規追加は不可**: 必ず claude.ai(Web)から追加
- **レート制限**: 150 req/h/user。LLM が連続呼び出しする場合に備えて全 read に 1h キャッシュ。429 時は `Retry-After` を 30s までクランプして 1 回リトライ

---

## 開発ノート

- [`docs/research.md`](docs/research.md) — 設計前に行った調査(Fitbit API の現状、MCP / Claude モバイルの仕様、先行実装サーベイ、出典付き)
- [`docs/journal.md`](docs/journal.md) — 開発ログ(決定理由、ハマり、使用感)
- [`scripts/diagnose-food-log.ts`](scripts/diagnose-food-log.ts) — Fitbit の foodLog API の挙動(栄養素キー名など)を直接確認するための reproducer。API が再び形を変えた時にパターン追加して実行すれば原因特定できるよう in-tree 保持

---

## Contributing

Issue / Pull Request 歓迎。設計判断は [`docs/journal.md`](docs/journal.md) を参照してください。

---

## License

[MIT](LICENSE)
