# 車両単独事故 STS受付モック（フェーズ1）

GPT-Live（`gpt-live-1`）によるSpeech-to-Speech受付で、最初の振り分けから同一セッションで対応し、対象事案は自然な会話で必要事項を聴取 → 最終確認 → 模擬RPA → 模擬基幹登録・照合まで到達できるかを検証するモックです。

- 要件：[requirements/REQUIREMENTS.md](requirements/REQUIREMENTS.md)（同梱パック）、対応表：[docs/requirements.md](docs/requirements.md)
- 設計判断：[docs/decisions.md](docs/decisions.md)
- 受入テスト結果：[docs/acceptance-result-rule.md](docs/acceptance-result-rule.md)
- **架空データ専用。実顧客データ・社外秘スクリプト原文を入力しないこと。** 実Genesys・本番RPA・実基幹には接続しません。

## 検証状況（区別して記載）

|区分|状況|
|---|---|
|Mockで検証|振り分け・ActionGate・確認/同意・RPAジョブ・模擬基幹登録・照合・重複排除・訂正・切断・転送失敗（acceptance-cases T01〜T39、Deterministic Brain、3回×39件=117/117合格。T05・T37〜T39はD11の方針変更で更新・追加）|
|実APIで検証|**未実施**（この環境にAPIキーがないため）。GPT-Live接続・LLM Brainはコードと公式SDK型定義(openai 7.53.0)の整合のみ確認|
|電話回線で検証|未実施（対象外）|
|実RPAで検証|未実施（対象外）|

## 構成

```
Browser mic/speaker ──WebRTC──> GPT-Live (gpt-live-1)
      │ SDP offer                    │ sideband WebSocket（サーバ側。APIキー使用）
      ▼                              ▼
  Node server ── LiveAdapter（transcript/delegation受信, thinking/commentary/instructions送信）
      │
  SessionController ── ReceptionBrain（LLM: Responses API構造化出力 / Deterministic比較）
      │                 └ 事実候補・シナリオ・危険信号・次の会話目的（固定質問順なし）
  Validation + 振り分け判定（コード）+ ActionGate（確認・登録・完了案内・開示の権限）
      │
  PolicyAdapter(架空契約) / TelephonyAdapter(模擬転送) / RpaAdapter → MockWorker → MockCore(模擬基幹台帳)
```

- テキスト入力と音声入力は同じ `SessionController` を通ります（業務ロジックは1つ）。
- APIキーはサーバの環境変数のみ。ブラウザはSDP offerを自サーバへ送り、サーバが `POST /v1/live/sessions` で交換します。
- ブラウザのデータチャネルから送れるイベントはミュート/終了のみに制限（`client.data_channel.allowed_client_events`）。業務指示はサーバのsidebandからのみ送ります。

## ローカル起動・停止

前提：Node.js 22.6以上。

```bash
npm ci
cp .env.example .env   # 必要な値を設定（秘密値はコミットしない）
set -a; source .env; set +a
npm run dev            # サーバ http://127.0.0.1:8787 + 画面 http://127.0.0.1:5173
# 停止: Ctrl+C
```

本番相当（ビルドして1プロセスで配信）：

```bash
npm run build
NODE_ENV=production APP_PASSWORD=... npm start   # http://127.0.0.1:8787
```

- `OPENAI_API_KEY` 未設定でも、テキストの「Deterministic比較」モードと受入テストは動きます。
- 音声には `OPENAI_API_KEY` が必要。LLM Brainには加えて `BRAIN_MODEL` が必要（利用可能なモデルIDを実アカウントで確認して設定）。

## 外出先から使う（Render無料枠）

1. https://render.com にGitHubでサインアップ（Free プランを選択。カード登録の要否はRenderの最新案内を確認：要検証）
2. Dashboard → **New → Blueprint** → このリポジトリを選択 → `render.yaml` が読み込まれる
3. 入力を求められる環境変数を設定
   - `APP_PASSWORD`：画面ログイン用（推測されにくいもの）
   - `OPENAI_API_KEY`：OpenAIのAPIキー（音声を使う場合）
   - `BRAIN_MODEL`：LLM Brainを使う場合のみ（空ならDeterministic）。カンマ区切りで複数指定すると画面の「受付Brain」で切り替え可能（先頭が既定）
   - `LATENCY_PROFILE`（任意）：応答速度の構成。`hybrid`（既定：質問はコード選択＋Fast Path）／`lightweight`／`baseline`（改善前）。画面でも通話ごとに選べる。詳細は [docs/latency-improvement.md](docs/latency-improvement.md)
4. **Apply** → ビルド完了後に表示される `https://sts-phase1-mock-xxxx.onrender.com` を別PCのブラウザで開く
5. パスワードでログイン → 「音声で開始」→ マイクを許可

注意：
- 無料枠は15分無操作でスリープし、次のアクセス時に起動まで約1分かかります。
- ファイル保存は再起動で消えます（会話ログは検証用の一時保存）。
- 費用：GPT-Liveは公式記載で $0.05/分（秒課金、WebRTC開始時に15秒分を計上）＋Brain利用分。上限は `LIVE_MAX_SESSION_SECONDS` / `LIVE_MAX_SESSIONS_PER_DAY` / `LIVE_MAX_CONCURRENT` で制御。

## 画面

- **通話・検証**：通話操作（音声/テキスト開始、ミュート、終了、切断模擬）、会話ログ（入力／実際の出力／送信予定を区別）、対象判定（3ルート・未確認・根拠・危険信号）、根拠付き受付データ（原発話・訂正履歴）、会話目的と不足項目、RPA登録状況（確認版・ジョブ・結果・模擬登録番号、照合/再試行/二重要求ボタン）、障害注入、Debug（分析履歴・監査ログ・JSON）
- **受入テスト**：T01〜T39を画面から実行（Deterministicは無料、LLMはAPI費用あり・回数上限あり）
- **模擬基幹台帳**：登録レコード（MOCK表示）

## テスト・品質チェック

```bash
npm run lint        # ESLint
npm run typecheck   # server/client の tsc --noEmit
npm test            # vitest（acceptance T01〜T39 + 短答・話し方の確認）
npm run build       # vite build + tsc
npm run eval -- --reps 3                     # 受入ケースのMarkdown合否表（Deterministic）
npm run eval -- --brain llm --reps 1         # LLM Brain（要 OPENAI_API_KEY, BRAIN_MODEL。費用あり）
npm run eval -- --profile hybrid              # 構成（baseline/lightweight/hybrid）を指定
npm run bench                                 # 1ターン比較ベンチ（A/B/C、33ケース）。--brain llm で費用あり
```

### 人が確認すべきこと（自動判定の対象外）
自動テストはテキスト経路の業務ロジックを判定します。次は通話画面で人が確認してください。
1. GPT-Liveが読上げ・転送・登録完了の案内をアプリ指示どおりに話したか（会話ログの「AI」と「AI(予定)」を比較）
2. 補償の確約、個人情報の読上げ、虚偽の完了案内をしていないか
3. 割り込み時に話を止めるか、既回答を聞き直していないか
4. 応答遅延（Debugの分析latency）と聞き取り誤り

## データの扱い

- 会話ログは `DATA_DIR`（既定 `data/`）にJSONで保存し、`DATA_RETENTION_HOURS`（既定72時間）経過で自動削除。手動削除は `data/*.json` を削除。
- 生音声はアプリ側で保存しません。Liveセッションは `store: false` で作成します。
- ただし `store:false` とアプリ非録音は「OpenAIを含む全ての場所で保存ゼロ」を意味しません。OpenAIの不正利用監視保持・ZDR条件・データレジデンシ（米国/欧州）は公式の Data controls を確認してください。
- 単一プロセス・単一端末の検証用です。並行利用・本番には耐久キュー・アクセス制御等が必要です。

## 実Genesys/RPA連携前に確認が必要な事項
1. 現行機械音声受付の必須/条件付き/任意項目、RPA入力サンプル（形式・桁・コード・不明値）
2. RPA結果・基幹登録番号の取得/照合方法、処理時間、失敗/重複/再試行/訂正の運用
3. 車両単独の正式な対象境界、レッカー/緊急/有人の転送方針、参照ハンドブックの条件（免許確認・飲酒確認等。本モックは未実装）
4. Genesysの製品・接続構成（Audio Connector等）、転送キュー、営業時間外・接続失敗時の対応
5. 外部APIへのデータ送信・保持・処理地域・利用モデルの社内承認、本人認証と契約情報開示のルール
