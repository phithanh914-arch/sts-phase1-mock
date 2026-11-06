# 設計判断の記録

作成：2026-11-06。状態はすべて「モックとしての判断」。本番方針ではない。

## D1. GPT-Liveの接続方式：WebRTC＋サーバsideband＋client delegation
- 確認した公式情報（2026-11-06、openai npm 7.53.0の型定義と公式ガイド）
  - モデルID `gpt-live-1`。WebRTCは `POST /v1/live/sessions`（SDK `client.live.create`）でサーバがSDPを交換。エフェメラルキー方式はGPT-Liveのガイドに記載なし。
  - sideband：`wss://api.openai.com/v1/live/sessions/{id}/attach`（SDK `SidebandWS`）。
  - client delegation：`session.delegation.created` は委任の通知であり、ユーザー発話のテキストもターン完了も含まない。結果は `session.thinking.append` / `session.commentary.append` / `session.instructions.append`（各500 tokens上限、`delegation_id`必須・nullable）。
  - transcript：`session.input_transcript.delta` / `session.output_transcript.delta`（start_ms/end_ms）。確定ターン完了イベントはない。
- 判断：業務状態はサーバが単独で持つため、transcript受信と指示送信はsideband（サーバ）で行う。ブラウザは音声とミュート/終了のみ。
- Realtime API（`/v1/realtime/calls` 等）のイベントとは別物として `server/src/live/liveAdapter.ts` に隔離。

## D2. 委任されていない分析結果は「話させない」
- transcriptのgapでも分析を走らせ、事実と状態を最新化する（委任を待つと状態更新が遅れるため）。
- ただし委任されていないときの通常の質問案は `thinking`（無音の背景情報）として渡し、GPT-Liveの自発発話と二重にならないようにする。
- 例外：読上げ確認・転送・緊急・登録結果など、ゲート済みで文言が決まっている案内は `instructions.append` で「そのまま伝える」よう指示する。
- 要検証：instructionsで文言どおりに話すか、言い換えや省略が起きるか（[S4] 事後監視だけでは発話を物理的に防げない）。

## D3. 読上げ確認の「出力済み」判定はヒューリスティック
- テキストモード：表示時点で出力済み。
- 音声モード：読上げ指示の受理（`session.instructions.appended`）後のAI出力transcriptが読上げ文の50%以上の長さで「確認」を含む場合に出力済みとする。**要検証**。
- 出力済みでなければ「はい」を同意として記録しない（ActionGate）。

## D4. 振り分けと権限はコード、会話の順序はLLM
- `decideRoute`（コード）：緊急 > レッカー > 有人希望 > 明確な非対象 > 未確認 > 対象。未確認をfalseにしない。
- `ActionGate`（コード）：確認準備・同意記録・登録提出・完了案内・契約開示。
- LLM Brainは次の会話目的と発話案を選ぶ。コードは不足項目の集合と制約だけを渡し、固定の next_field を返さない。
- 自動完結の事案種別は allowlist（`collision` のみ）。当て逃げ・故障・盗難等は対象外。

## D5. Deterministic比較モード（RuleBrain）を併設
- 既存リポジトリがなく「既存Deterministicモード」は存在しなかったため、比較用・APIなし回帰テスト用に新設。
- これは固定順の質問をする（＝過去モックのIVR的方式に相当）。LLM方式との比較対象として残す。
- キーワード規則のため、自由な言い換えへの頑健性はない。業務ロジック（ゲート・状態遷移）のテストに使う。

## D6. 世代管理と後着結果
- 分析は会話ごとに直列化。各分析に `analysisId`・`baseStateVersion`・`inputWatermark` を付与。
- 適用時に版が変わっていれば破棄して再評価。タイムアウト後に届いた結果は `late_discarded` として記録のみ。
- 事実が変わると版を上げ、未同意の確認は失効。同意後の変更・QUEUEDジョブは取消して再確認。RUNNINGは停止要求→書込前停止なら再確認、書込済みなら訂正待ち（有人）。2件目の新規登録はしない。

## D7. RPA・基幹は模擬、形式はモック独自
- `mock-rpa-v0.1`。既存RPAの入力形式ではない。Mapperはコードで行い、LLMに列や形式を決めさせない。
- 冪等性：ジョブ台帳（同一idempotency_key）と模擬基幹台帳の両方で重複排除。Exactly-onceは保証しない。
- OUTCOME_UNKNOWN は自動再送しない。画面の「基幹台帳を照合」で同一キーの登録を回収。

## D8. 契約照会
- 架空契約2件。「2項目一致」は契約特定の基準として扱い、本人認証・開示許可とは別。モックは本人認証を実装せず、開示は常に不可。
- 契約未特定で事故概要が揃った場合は HANDOFF_PENDING → 有人引継ぎ（登録完了とは言わない）。

## D9. ホスティング：Render無料枠（Takaさん選択 2026-11-06）
- 常駐Nodeプロセス（SSE・模擬Worker・sideband WebSocket）が必要なためサーバレスではなくWebサービス。
- 外部公開のため `APP_PASSWORD` 必須（production で未設定なら起動拒否）。署名付きHttpOnly Cookie、ログイン試行のレート制限。
- 費用・負荷の上限：1通話の最大秒数、同時接続数、1日のセッション数、LLM評価の最大回数。

## D10. 未実装（要件にあるが根拠資料が未取得のもの）
- 免許確認・22時〜5時の飲酒確認・警察届出等の条件付き項目：正式ルール未取得のため実装しない（LLMで補わない）。
- 本人認証、実SMS、Genesys転送、実RPA/基幹。

## D11. 物損（公共物・無人の駐車車両）をSTS対象に拡大（Takaさん決定 2026-11-06）
- 意図：車対工作物・車対停車車両など緊急性の低い事故をSTSで受け付ける（REQUIREMENTS.md §3.3 の「GPT提案」の暫定条件を変更）。
- STSで受け付ける：
  - 公共物（電柱・ガードレール・標識・信号機等）への接触：相手情報は聞かない。警察届出（`police_reported`）を聴取。`property_ownership=public`。
  - 人が乗っていない駐車車両への接触（`parked_vehicle_unoccupied=true`）：相手の名前・住所・電話番号と警察届出を聴取。
  - 相手情報・警察届出は「分からない」でも登録まで進める（`explicitly_unknown`）。登録データに `counterparty.contact_required=true` と、不明があれば `info_incomplete=true` を付ける。
- 有人のまま：人が乗った相手車（信号待ちの追突等）・走行中の相手車・歩行者・自転車、他人の塀・店舗の壁・借家（`property_ownership=third_party`）、当て逃げ、けが・レッカー・緊急・有人希望。
- 受入ケース：T05（電柱）を OPERATOR → SELF_SERVICE に変更し、警察届出の聴取と登録まで確認。T03 は「相手車に人が乗っていたか」を確認してから OPERATOR。T37（無人の駐車車両）・T38（人が乗った停車車両）・T39（駐車車両の持ち主不明）を追加。`requirements/acceptance-cases.json` は原本のまま残し、差分はここに記録する。
- D10の「警察届出」は、この範囲（公共物・駐車車両）に限り聴取する。届出の要否判定や案内はしない。

## D12. Live発話の調整（2026-11-06）
- 委任中のつなぎ言葉（「承知しました、確認しますね」）を言わないようにLive instructionsで指示。Brainの発話案にも毎回の前置きを付けない。LLM Brainの分析中（1回6〜8秒）は無言になる点は要検証。
- 委任なしの「そのまま伝えて」指示（転送結果の案内など）は、前の「そのまま伝えて」の発話が終わってから送る（発話が混ざる問題への対策）。終わりの検知は出力transcriptの区切りで行い、10秒で強制的に次へ進む（要検証）。

## D13. LLM Brainの応答時間と言い回し（2026-11-06 Takaさん実機フィードバック）
- 間が長い（gpt-6-luna で分析1回6〜8秒）→ Responses APIに `reasoning.effort`（環境変数 `BRAIN_REASONING_EFFORT`、既定 `low`）を渡す。モデルが受け付けない場合は初回エラー後に指定なしへ自動で戻す。効果は実機で要検証。
- けがの質問は一度だけ。「いない」なら全員分の回答とし、乗車人数は聞かない（本人だけの否定のときのみ同乗者を確認）。
- 安全の確認は「急いで対応が必要な状況はありますか」の趣旨で聞き、「煙・火など」の例示や「危険な状況」という言い方をしない。

## D14. 音声側に質問を作らせない（2026-11-06 Takaさん実機フィードバック「矢継ぎ早で話しづらい」）
- 事象：GPT-Liveが、バックエンドの質問に別の質問を付け足したり（「けがをされている方はいますか」）、委任の結果を待たずに自分で質問を作ったりして、質問が連続していた。
- 対策：
  - 話す内容は質問も含めてすべて `session.instructions.append`（そのまま伝えて）で渡す。言い換えの余地があった `commentary` は使わない。
  - 背景情報（thinking）から「未取得項目の一覧」を外し、「自分から話さない参考情報」と明記した。
  - Live instructionsに「届いた内容だけを話す・付け足さない・質問したら答えを待つ」を追加。Brainの発話案は質問1つに限定。
- 副作用（要検証）：言い回しが固定的になる。自然さはBrainの発話案の質で担保する。

## D15. つなぎ言葉と言い回し（2026-11-06 Takaさん実機フィードバック）
- 実測（CONV-8a152496）：顧客の発話終了から次の質問まで約6〜8秒。内訳は、発話の区切り検知 約1秒、LLM Brain（gpt-6-luna、reasoning low）3.4〜5.9秒、音声側が話し始めるまで 約1〜2秒。最大要因はBrain。
- 委任から `LIVE_FILLER_AFTER_MS`（既定2500ms）経っても結果が出なければ、「確認いたします。」とだけ言う。言い終わる前に届いた結果は、言い終わってから送る。
- 相づちは「はい」のみ（「うん」「ええ」は使わない）。名前は「カタカナで」と言わずに聞く。
