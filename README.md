# fitbit-logger-mcp

Claude モバイル / Claude Desktop / Claude.ai から Fitbit のヘルスデータを取得し、食事写真から食事ログを書き込める Model Context Protocol (MCP) サーバー。TypeScript 実装、Cloudflare Workers にデプロイ。

> **⚠ 2026/09 に Fitbit Web API は完全停止します。** 後継は [Google Health API](https://developers.google.com/health)。本実装は Provider-agnostic 設計で、停止前に Google Health 実装へ切り替え予定。既存 Fitbit OAuth トークンは移行できないため、ユーザーは再認可が必要になります。あわせて、Fitbit アカウント自体の Google Account 統合(期限 2026/05/19、未対応は 2026/07/15 にデータ削除)も事前に済ませておいてください。

## 現状

🚧 開発中。詳細は [`docs/journal.md`](docs/journal.md) を参照。

## 何ができる予定か

- Fitbit の広範なヘルスデータ取得(Activity / Heart Rate + Intraday / Sleep v1.2 / Body / Nutrition / SpO2 / 呼吸数 / 皮膚温 / HRV / VO2 Max / Devices)
- 食事 / 水 / 体重 / 体脂肪率 / 活動 / 睡眠の書き込み
- **食事写真 → Claude が視覚解析 → `log_meal_photo` で Fitbit 食事ログに一括記録**(Claude モバイルで使える本命ツール)

## ドキュメント

- [`docs/research.md`](docs/research.md) — 本実装を設計するために行った調査結果(Fitbit API の現状、MCP / Claude モバイルの仕様、先行実装サーベイ、出典付き)
- [`docs/journal.md`](docs/journal.md) — 開発ログ(決定の理由、ハマリポイント、使用感)
- [実装計画(プランモードで生成)](https://github.com/tachibanayu24/fitbit-logger-mcp/blob/main/docs/research.md) — 参考

## License

MIT
