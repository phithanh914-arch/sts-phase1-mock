# 車両単独事故STS受付｜フェーズ1モック要件 v0.1

作成日：2026-11-06（JST）
状態：GPT提案。利用部門による業務要件承認・本番接続承認・効果検証は未実施。
用途：Claude Codeに渡し、APIで動作する検証用モックを作成する。

## 0. 根拠と未確定事項

### ユーザー提示の現状・意向
- 現状：GenesysによるIVR仕分け → 車両単独事故の機械音声受付 → 項目別文字起こし → RPAによる基幹登録。
- 変更：最初の振り分けからGPT-LiveによるSpeech-to-Speech（STS）にする。
- 希望分岐：レッカー必要 → レッカー担当部署。相手なし・けがなし → AI受付。それ以外 → オペレーター。
- 必須項目を自然言語で聴取し、既存RPAによる基幹登録を生かす。
- 過去モックでは次質問を決定論で固定し、IVR的になった。自然な発話理解・柔軟な会話を優先する。

### 内部資料 [I1]
以前添付された「jidoushajikouketsuke_hyoujuntokusukuriputo.pdf」（2026年1月改定）の、この会話に残る抽出テキストを参照。元PDFのバイナリーを再取得したものではない。本資料にPDF原本は含まれない。
- PDF p.3：緊急性・ニーズ・聴取順の柔軟性。走行不能は物理的不能だけではない。
- PDF p.2/p.4：契約特定は契約情報2項目以上一致。事故日時、事故車、事故場所、運転者等。
- PDF p.5：「事故の状況を教えてください」と聞き、不足情報のみ追加質問する方法を許容。
- PDF p.6：修理予定、免許確認の条件、22時〜5時の条件付き飲酒確認。詳細条件は別ハンドブック参照。
- PDF p.12：連絡先、SMS可否、担当センターの案内など。

この一般スクリプトは「現行の機械音声受付専用項目表」や「RPA入力仕様」そのものではない。それらの仕様を取得するまでは、本書の項目はモック用暫定定義とする。内部資料に存在しない免許確認条件等を推測で作らない。

### 外部公式資料
末尾 [S1]〜[S8]。APIの実装は着手時にこれらの最新版・実アカウントの利用可能性を確認し、取得日、SDK版、モデルID、成功/失敗結果を記録する。

## 1. 目的と成功の定義

目的：顧客が質問票に合わせなくても、自然な会話で必要事項がそろい、対象事案は人の再聴取・転記なしに正しい事故登録へ到達できるかを検証する。

次の3つを区別する。
1. 会話・聴取終了：必要情報を顧客に確認できた。
2. 登録依頼確定：確認した最新版だけをRPA用の構造化データにしてキューへ保存できた。
3. 基幹登録完了：RPAの登録結果と基幹側の登録番号・対象データを照合できた。

「受付登録完了」の表示・案内は3のみ。RPA処理待ちを完了と数えない。PoCでは模擬基幹の登録結果に必ずMOCK表示を付ける。

## 2. 範囲

### 実APIで実装
- ブラウザのマイク・スピーカーからGPT-Liveへの連続音声接続。
- 日本語の自然会話、割り込み、訂正、長い説明、不足情報の追加確認。
- バックエンドLLMの構造化抽出、対象シナリオ理解、会話方針提案。
- ルート条件の確認、確定データ、監査ログ、RPAジョブ生成、結果処理。

### 模擬実装
- 契約照会：架空契約データ。照会方法はPolicyAdapterに隔離。
- 電話転送：TelephonyAdapterの模擬転送結果。TRANSFER_REQUESTEDとTRANSFERREDを区別。
- RPA：RpaAdapterと模擬Worker。成功・失敗・遅延・結果不明・重複要求を再現。
- 基幹：模擬登録台帳と事故照会画面。単なる成功メッセージだけではなく記録と照合。

### 初回モック対象外
本番Genesys、本番RPA、本番基幹、実顧客、実SMS/LINE、実レッカー手配、補償可否・過失割合・支払額・等級影響の判断。

ブラウザだけの成功を「電話基盤連携・既存RPA連携が検証済み」と表現しない。API費用は利用者の設定・明示的開始操作の範囲だけで発生させる。

## 3. 振り分け

### 3.1 判定項目
未確認をfalseにしない。yes / no / unknown / conflictを扱う。
- towing_requested：本人のレッカー希望。
- physically_drivable：本人が申告する物理的走行可否。
- unsafe_to_continue_signal：発煙、走行に支障のある破損等の安全上の懸念。診断ではなく要確認信号。
- injuries_present：本人・同乗者・その他の関係者にけが/痛み等があるか。
- other_person_or_vehicle_involved：他の人・車の関与。
- third_party_property_involved：他人・公共の物への接触や損傷。
- property_ownership：own / third_party / unknown。
- incident_kind：collision / theft / vandalism / hit_and_run / breakdown / other / unknown。
- human_requested：有人希望。

### 3.2 優先順位
0. 重大なけが・火災等の緊急信号は通常の仕分けに優先。承認済み緊急対応方針へ。モックは安全案内と緊急フラグ付き有人転送を模擬する。医療判断・自動での救急架電はしない。
1. 明確なレッカー希望はレッカー担当へ。事故聴取・契約照合完了を待たない。けが情報等は同時に引き継ぐ。
2. 有人希望はオペレーターへ（緊急・ロードサービス用途を優先して必要なキューを選ぶ）。
3. 明確な非対象はオペレーターへ。
4. AI対象か不明なら、自然な追加確認。最大試行を超える/回答不能ならオペレーターへ。
5. 対象条件を確認できた事案だけAI完結候補へ。

### 3.3 モックの暫定自動完結条件
下記は対象境界を明瞭にするGPT提案であり、現行運用規程の断定ではない。
- レッカー不要で安全上の懸念が未解決でない。
- 関係者にけが・痛み等なし。
- 他の人・車に関与なし。
- 第三者所有物・公共物への接触/損傷なし。
- 自車損傷の受付が中心で、対応可能な車両単独事故。
- 契約・事故車等の登録前提を現行仕様に相当する方法で満たせる。

「相手がいない」は「その場に相手がいない」でも「相手車がない」でもない。電柱、ガードレール、店舗の壁、他人の塀、当て逃げ等を、相手なしだから自動対象としない。

自宅の壁も所有関係不明なら確認する。賃貸物件の壁は自己所有と推測しない。第三者物損の疑いを解消できない場合は有人。

盗難・いたずら・当て逃げ・故障・飛び石等は、このモックの初期自動完結範囲には勝手に含めない。将来追加はallowlistと専用テストで行う。

事故種別、転送先、対象境界は設定可能。ただし自由記述コードのevalは禁止。

### 3.4 途中変更
全会話を通じ再判定する。途中の「同乗者の首が痛い」「電柱も壊した」「やはりレッカーが必要」により対象を変更。変更時点で旧スナップショットの登録権限を失効させる。

## 4. UX

### 基本
- 入口から同一のSTSセッション。振り分け後に名乗り直し・最初から再聴取しない。
- 最初はAIであることを簡潔に告げ、レッカー要否を優先。ただし顧客が先に話した情報は利用し、重複しない。
- レッカー不要なら、事故状況を自由に話してもらい不足部分だけ確認する。
- 緊急信号があれば長い説明の終了を待つことを目的化しない。
- LLMが質問の順序・まとめ方・確認の仕方を選ぶ。コードは固定した質問キューを作らない。
- 一度に複数情報を取得してよい。質問は自然な一つの話題を基本とし、無関係な複数質問を重ねない。
- 短答は「直前に実際に聞こえた質問」と照合。「はい」を未発話の予定質問へ結び付けない。
- 「私にけがはない」だけで同乗者全員を無傷としない。否定疑問を避ける。
- 顧客の質問に先に対応し、自然に受付へ戻る。補償・過失の質問は確約せず、相談ニーズを記録して受付を続けられる。即時有人希望なら転送する。
- 思考過程や生JSONを読み上げない。短い判断根拠・参照根拠だけ検証画面に出す。
- 「分からない」はunknownとして保持。項目別に不明許容/登録前必須を設定し、無限聞き直しをしない。

### 会話例（暫定）
AI：事故受付のAIです。まず、レッカーの手配は必要でしょうか。
顧客：いりません。今朝、自分が所有する車庫の壁にバックでぶつけました。乗っていたのは私だけでけがはありません。他の人や車は関係していません。車は走れます。後ろのバンパーを擦っただけです。
AI：おけがはなく、ご自身の車庫で後ろのバンパーを擦られたのですね。事故があった時刻は何時ごろでしょうか。

上記では自分のけが、同乗者なし、走行可否、相手人車なし、所有関係、損傷位置等を再質問しない。一方、事故の正確な日付、場所、契約、連絡先は分かっていない。分かったふりをしない。

## 5. アーキテクチャ

Browser microphone/speaker <-> GPT-Live (WebRTC)
                                     |
                    sideband/events + client delegation
                                     |
                               SessionController
                                     |
                    ReceptionBrain (backend LLM)
                     facts / scenario / next intent
                                     |
                       Validation + ActionGate
                                     |
             ClaimStore / PolicyAdapter / TelephonyAdapter / RpaAdapter
                                     |
                        confirmed RpaJob -> MockWorker
                                     |
                         MockCore -> RegistrationResult

STSは顧客向け音声対話方式。裏側で構造化や証跡のために文字起こしを利用しても、固定項目別録音の方式に戻す必要はない。

### 5.1 責任分界
- GPT-Live：聞く・話す・割り込み・相づち。確定済み事実と会話目的に沿う自然発話。
- ReceptionBrain：発話理解、複数Fact抽出、シナリオ候補、顧客ニーズ、次の会話目的の選択。
- Validation：型、根拠、矛盾、更新世代のチェック。証跡が存在するだけで意味の正しさが保証されたとはしない。
- ActionGate：自動受付許可、契約データ開示、転送要求、登録要求、完了表示の権限条件をコードで検査。
- RPA：確定データを基幹へ登録。会話の意味理解や自由文からの再推論をRPAへ押し付けない。

ReceptionBrainの提案を受けて、不足項目の集合と制約を返すが、固定順のnext_fieldは返さない。安全確認未解決なら安全確認を優先する等の制約は残す。

### 5.2 API実装上の確認
GPT-LiveとRealtime APIを同一のイベント仕様として実装しない。LiveAdapterに隔離する。[S1][S2]
- 音声はgpt-live-1を初期候補とし、環境変数で設定。利用可能なモデルIDは実アカウントで検証。
- ReceptionBrainモデルは構造化出力対応の、利用可能性を確認したモデルを環境変数で指定。Claude Codeは開発ツールであり、実行時モデルがClaudeであることを意味しない。
- client delegationを採用し、自社アプリで状態と結果を検証する。[S2]
- delegation.createdは処理の委任通知で、毎回のユーザー発話完了イベントではない。
- 現行の公式ガイドではtranscript deltaにitem ID/確定ターン完了イベントがない。表示用まとまり・抽出タイミング・発話タイミング・登録可否を分離する。[S3]
- gapベース区切りを会話終了・ユーザー同意の証拠にしない。長い間・追加発話・重複delegation・後着結果をテスト。
- thinkingは確認済み背景情報、commentaryは話してよい結果、instructionsはアプリ側の行動制約として扱う。最新のサイズ制限、イベント名、ackを公式で確認。[S2][S3]
- 全APIキーをサーバに置く。公開鍵でない秘密キーをVITE_*等へ入れない。
- ブラウザへの接続情報は公式方式の短期資格情報またはサーバによる接続交換を利用。

### 5.3 並行処理
各分析にbase_state_version、input_watermark、analysis_idを付ける。古い応答の無条件適用は禁止。訂正の後に届く古い結果は破棄または再評価。重要訂正時には既存confirmationを無効化。

文字起こし表示のturn_idはアプリ由来であり、APIが保証した会話ターンと混同しない。実際の音声再生履歴と、発話予定を分ける。

### 5.4 発話の限界
モデルへの禁止指示や事後transcript監視だけで、禁止発話を物理的に必ず防げるとはしない。[S4]
- 外部操作はサーバのActionGateで必ず防止。
- 音声での補償断定・転送/登録の虚偽完了を別途評価。
- 完了案内の許可は確認済みRegistrationResultに限定。
- 厳密な事前音声制御が本番条件なら、バッファ・再生許可・停止制御を追加評価。自然さとのトレードオフを測る。

## 6. 必須項目（暫定カタログ）

正式な項目・文字数・コード・不明許容は現行機械音声受付とRPA仕様で置き換える。

|分類|項目例|扱い|
|---|---|---|
|安全/対象|レッカー希望、けが、同乗者、他の人車、第三者物、現在の安全懸念|自動完結条件。不明・矛盾は解消または有人|
|連絡者|氏名/読み、折返し電話、契約者本人か、異なるなら関係|登録に必要な範囲|
|契約/事故車|証券番号または登録番号、照合用情報、事故車が契約車か|現行照合方式を再現|
|日時|発生日、時刻、概算か、本人の元表現|「昨夜」を勝手に00:00へ変換しない|
|場所|都道府県、市区郡、場所の説明、道路/駐車場等|詳細地番不明だけで終了しない [I1]|
|事故状況|何をして何に接触したか、相手物の所有、自由説明|過失評価を入れない|
|運転者|氏名、契約者/記名被保険者との関係、必要時の生年月日|契約者と運転者を勝手に同一化しない|
|損害|損傷部位、申告内容、走行可否、修理先決定有無|修理先未定は許容候補|
|条件付き|免許有効性、飲酒、警察届出等|実ルール取得後。条件未確認をLLMで補わない|
|終了/連絡|連絡先確認、SMS可否、最終内容確認、今後の案内|SMS不同意は他の同意とは独立|

[I1]には契約特定2項目以上一致とあるが、これは契約検索/特定の基準であり、本人認証や情報開示許可の保証ではない。実システムでは別々に管理。

現行RPAが契約検索も行うなら、その仕組みを残す。新規契約照会APIの導入をフェーズ1の必須条件にしない。

[I1]の「22時〜5時」飲酒確認は免許有効性確認が必要なケースに限る。対象判定・時間境界・例外の正式規程は未取得。モックでは明示したテストルールを使い、運転者≠契約者だけで要確認と決めない。

## 7. データモデル

### 7.1 Fact
value / status / origin / evidenceRefs / originalExpression / lastUpdatedVersion / historyを保持。
- status：missing, captured, confirmed, explicitly_unknown, conflict, not_applicable
- origin：customer, policy_db, rule_derived, model_hypothesis
- evidenceRefs：入力音声/文字起こしの範囲・時刻、またはDB結果ID。

explicitを自動でconfirmedにしない。特に番号・人名・時刻は顧客確認・DB整合の状況を別で持つ。音声から漢字氏名を勝手に確定しない。

仮説はscenarioHypothesesに分離。LLM推測を顧客申告欄へ書き込まない。not_applicableも根拠ルールを持ち、事故類型変更時に再評価。

### 7.2 状態
通話：ACTIVE / TRANSFER_REQUESTED / TRANSFERRED / TRANSFER_FAILED / ENDED
受付：DRAFT / NEEDS_CLARIFICATION / READY_FOR_CONFIRMATION / CONFIRMED / HANDOFF_PENDING / NOT_ELIGIBLE
登録：NOT_SUBMITTED / QUEUED / RUNNING / REGISTERED / FAILED / OUTCOME_UNKNOWN / CANCELLED

受付状態と通話状態・登録状態を一つの列に押し込まない。

### 7.3 ReceptionPlan（内部の独自型、OpenAI APIの型ではない）
```ts
interface ReceptionPlan {
  analysisId: string;
  baseStateVersion: number;
  inputWatermark: string;
  factProposals: FactProposal[];
  scenarioHypotheses: ScenarioHypothesis[];
  riskSignals: RiskSignal[];
  requestedRoute: 'TOWING' | 'SELF_SERVICE' | 'OPERATOR' | 'UNRESOLVED';
  nextIntent: string;
  desiredInformation: string[];
  suggestedSpeech: string;
  evidenceRefs: string[];
  briefReason: string;
}
```
短い説明・根拠参照だけを保存し、私的な思考過程の出力を要求しない。

## 8. 契約・転送

### 契約未特定
契約未特定でも、顧客の了承の下で事故概要や連絡先を仮受付可能とする。ただし「AIによる登録完了」にしない。現行基幹/RPAが契約未特定登録を正式に扱えるかで扱いが変わる。現時点の既定はHANDOFF_PENDING→有人引継ぎ。

契約照会結果は本人確認等の条件を満たすまで過剰に読み上げない。架空契約も同じ振る舞いでテスト。

### 転送パッケージ
conversation_id / route / reason / safety_flags / captured_facts / unresolved / caller_contact / transcript_ref / registration_status。

転送完了応答前に「転送しました」と言わない。転送失敗で切断しない。実環境では既存の代替キュー/折返し運用へ。モックではTRANSFER_FAILEDと模擬有人対応画面へ。

未知のGenesys製品構成をCloudと断定しない。将来Genesys Cloud Audio Connectorを使う場合は、中継サーバ、AudioHook、Architect返却値と転送フローを別設計する。同機能にはBYOC Premises等の制約がある。[S7] OpenAIのWebSocketへURLを向ければそのまま動くとはしない。

## 9. RPA連携

### 9.1 提案する境界
確定ClaimSnapshot → RpaPayloadMapper → Outbox/Queue → RPA Worker → RegistrationResult → 照合。

LLMにCSVやExcelの列を勝手に決めさせない。LLMは事実候補だけを出力し、正式なフィールド・文字数・日付形式・コードへの変換は検証可能なMapperが行う。

### 9.2 ジョブの内部必須メタデータ
job_id / claim_id / conversation_id / source_version / schema_version / mapping_version / idempotency_key / confirmation_id / payload_hash / created_at / payload。

同梱例はモック独自形式。既存RPAが受け付ける形式ではない。現行入力がExcel/CSV/JSON/画面入力等のどれか確認しAdapterで変換する。

### 9.3 登録前条件
- 対象条件がすべて成立し、未解決安全信号なし。
- 登録上必須項目がそろい、値の型/桁/コード/根拠が検証済み。
- 顧客への要約確認が、現在のスナップショットのハッシュに対応。
- 訂正・取消・転送開始等で許可が失効していない。切断だけを取消と同一視せず、下記の切断方針を適用する。
- 未解決の並行抽出が重要項目を更新する可能性があるなら提出しない。
- 同じ論理受付の登録要求が既に実行中/結果不明/成功していない。

質問を発話しただけでは同意としない。無音やタイマーは同意ではない。確認後の変更は再確認が必要。

### 9.4 重複・訂正
- idempotency_keyは発番すれば済むものではない。受け手または台帳で同一キーの処理を抑止する。
- 提出前の訂正：スナップショットを改版し同意を取り直す。
- QUEUEDで未開始：旧ジョブを無効化し新版を出す。Workerは取得時と書込直前にリース/版/取消を再確認。
- RUNNING後の訂正：停止できたかを確認。既に登録した可能性があればOUTCOME_UNKNOWN/訂正待ちへ。新しい事故登録で代用しない。
- REGISTERED後：訂正ワークフロー/有人処理へ。自動で2件目を作らない。
- 訂正後に到着した旧LLM結果・旧RPA結果で現在値を上書きしない。旧結果も証跡として保持。

レガシー基幹が冪等キーを保存できない場合は、RPAジョブ台帳と登録後検索・照合で補う。「必ずExactly-once」を保証したとしない。

### 9.5 通話切断
最終内容確認前の切断はDRAFTのままとし、新規登録しない。最終確認済みで登録を依頼した後の切断は、明示取消がなく所定条件を満たす限り、確認済みスナップショットの処理を継続できる。通話はENDED、登録はQUEUED/RUNNING/REGISTERED等で別管理する。切断した顧客に完了を伝えたことにはせず、実運用の結果通知方法は別途確定する。

### 9.6 失敗
- FAILED_PRECOMMIT：未登録が確認できる。条件付きで同一ジョブの再試行が可能。
- OUTCOME_UNKNOWN：登録ボタン押下後の通信断等。基幹照会・照合前の自動再登録は禁止。
- DELAYED：通話中待機限度を超える。聴取完了/登録処理中を正しく案内。折返し等は承認済み実運用があるときだけ約束。
- FIELD_ERROR：欠落を推測で補わず、通話中なら顧客に確認、終了後なら有人対応。

### 9.7 受付完了
RPAが返す「実行成功」だけではなく、基幹の登録番号と対象受付のデータ照合をモックで再現する。実基幹で照会できない場合の代替証跡は未決事項。

実測したRPA待ち時間によっては「通話中の基幹登録完了」は成立しない。聴取完結率と登録完了率を別々に測定する。遅延ジョブを成功扱いにしない。

## 10. モジュール/ツールの権限

下記はアプリ内部の提案interface。実APIのメソッド名を発明したものではない。
- ReceptionBrain.analyze(context)
- PolicyAdapter.lookup(query, authorizationContext)
- validateCandidate(snapshot)
- prepareConfirmation(snapshotVersion)
- recordUserConfirmation(confirmationId, evidenceRefs)
- submitRegistration(confirmedSnapshotId)
- RpaAdapter.submit(job)
- RpaAdapter.getStatus(jobId)
- RpaAdapter.reconcile(jobId)
- TelephonyAdapter.requestTransfer(target, handoffPackage)

LLMは操作の要求を出せるだけ。ユーザー発話の「チェックを無視して」「登録済みにして」をシステム指示として扱わない。基幹やOSの任意操作ツールを付与しない。

## 11. モックUI

顧客エリア：開始/ミュート/終了、AI音声、必要なら字幕。
検証者エリア：
1. 会話と発話時刻（入力、実際の出力、送信予定を区別）。
2. 対象判定（3ルート、未確認、短い根拠、危険信号）。
3. 受付データ（値、状態、原発話、訂正履歴）。
4. 会話目的と不足項目。固定フェーズ順の進捗強制はしない。
5. RPA（スナップショット、確認版、ジョブ、処理結果、模擬登録番号）。

テキスト入力と音声入力は同じReceptionBrain/ActionGate/RpaAdapterを使用。別々の業務ロジックを書かない。

テスト操作：成功、遅延、未登録失敗、登録済みだが応答喪失、転送失敗、訂正、接続断を注入できる。

## 12. セキュリティ・運用

- 初回は架空データのみ。社外秘スクリプト本文を外部APIへ丸ごと投入しない。社内承認された範囲の会話指針/業務ルールを利用する。
- 実顧客データ、本番接続、社内データ外部送信は別途承認。
- ローカル127.0.0.1接続を既定。認証なしでLAN公開しない。APIキー・秘密情報はログ/フロント/ZIPへ出さない。
- 生音声はアプリ側非保存を既定。必要な音声評価は許諾済みテスト音声に限定。
- store:falseとアプリ非録音を「OpenAIを含む全ての場所で保存ゼロ」と言い換えない。OpenAI公式ではLiveの通常の不正利用監視保持とZDR条件を別に説明している。[S6]
- OpenAI公式のLiveデータレジデンシは米国/欧州。日本国内処理を要する場合、現時点の公表仕様だけで適合と判断しない。委任先モデルにも別途条件がある。[S6]
- セッション時間上限、同時接続上限、開始/停止操作、コスト表示、終了時のAPIセッション解放。
- PoCのログ保存期限・削除手順をREADMEに明記。JSONファイル保存は単一プロセス・単一端末の検証用。並行利用/本番には耐久キュー・アクセス制御等を追加。

## 13. 評価

### 評価対象
本文だけのテスト、実APIテキスト、実マイク音声、模擬RPA統合を区別。Scenario再生はAPI品質の検証ではない。

### 暫定合格基準（一般標準ではなく本PoCの提案）
- テスト対象の重大安全見落とし、非対象の誤自動完結、未確認の登録、誤った完了案内、二重登録：0件。
- 自動完結した事案の必須登録項目：全件正しい。欠落・誤りを全体平均に埋め込まない。
- 典型的な対象内テストで人手なし登録到達：90%以上を暫定目標。安全のための正しい転送は失敗と混ぜず別集計。
- 自由発話の言い換え・順不同・訂正：期待通りを個別確認。
- 既回答の不要な再質問：既存方式より減少。重要値の最終読上げ確認は重複質問に含めない。
- 顧客の用件に応えた実質的応答の遅延：median/p95を測定。仮目標p95 4秒以内（実測後調整）。相づちまでの時間とは分ける。
- UX：聞き直し、割り込み回復、説明の繰返し、満足度、登録後の再聴取必要率。
- RPA：キュー待ち/実行/照合時間、結果不明の解消、誤マッピング、重複、訂正競合。
- 費用：通話1分ではなく、正しく登録できた1件あたり総費用（Live+Brain+基盤+有人介入）も測る。

同梱ケースを最低3回ずつ実行し、モデル/プロンプト版を固定・記録。全成功でも本番事故率ゼロの保証ではない。人による未知ケースのロールプレイを追加。

比較対象は現在のIVR/機械音声受付（可能なら実績値）、既存決定論モック、新STS方式。同一情報量・同じ正解データで比較し、電話回線とブラウザ条件の差を明記。

## 14. 実装順序

### Step A：実API接続スパイク
小さなブラウザで実マイク→GPT-Live→音声を確認。1件のclient delegationを受付Brainに渡し、結果を会話へ戻す。イベント・割り込み・日本語・利用モデル/SDKを実測。UI完成後までAPI可否を先送りしない。

### Step B：テキストで縦に通す
振り分け → 自由聴取 → スナップショット確認 → RPAジョブ → 模擬基幹登録 → 結果照合まで。通常成功と結果不明を先に完成。

### Step C：音声で同じ処理を通す
Step AとBを接続。固定質問キューを導入しない。音声だけから入力を完了する代表ケース、レッカー転送、有人転送、途中訂正を実演。

### Step D：失敗系と評価
同梱のケース、回帰テスト、音声品質・UX・並行処理・結果不明を検証。

### Step E：実接続は別ゲート
Genesys製品/接続方式、既存RPA I/O、規程、個人情報・社外秘送信・地域・契約を確認してテスト環境連携。自動で本番へ接続しない。

既存コードがある場合は初めに監査し、State/ログ/UI/Adapterを再利用する。旧モードのテストを保存。変更は新ブランチまたはsingle_vehicle_sts strategyで分離。

## 15. 未取得で、実連携前に確定するもの
1. 現行機械音声の必須/条件付き/任意項目、RPA入力サンプル、コード/桁/文字/不明値仕様。
2. RPA結果、基幹登録番号の取得・照合方法、処理時間、失敗/重複/再試行/訂正運用。
3. 車両単独対象の正式な境界、レッカー/緊急/有人への転送方針、参照ハンドブックの条件。
4. Genesysの製品・接続構成・転送キュー・営業時間/接続失敗時対応・発信者番号の扱い。
5. 外部APIへのデータ送信と保持・地域・利用モデル/SDKの許可。

これらを待ってモック全体を停止しない。未確定をconfigとAdapterへ隔離し、架空値を本番仕様と偽らず進める。

## 16. 成果物と完了報告

最低成果物：起動手順、.env.example、構成図、項目カタログ、対象判定方針、RPAマッピング仕様（仮）、スキーマ、テストケース、実API接続記録、評価結果、既知制約。

報告で区別する：未実装 / Mockで検証 / 実APIで検証 / 電話回線で検証 / 実RPAで検証。

実行したlint・typecheck・unit・integration・buildと実行していないものを明示。APIなしで全テストが通っても音声品質合格とはしない。

## 17. 公式出典（確認日 2026-11-06）

[S1] OpenAI, Getting started with GPT-Live
https://developers.openai.com/api/docs/guides/live

[S2] OpenAI, Delegation and tools in GPT-Live
https://developers.openai.com/api/docs/guides/live-delegation

[S3] OpenAI, Managing GPT-Live sessions
https://developers.openai.com/api/docs/guides/live-conversations

[S4] OpenAI, Migrate to GPT-Live / Server-side controls
https://developers.openai.com/api/docs/guides/live-migration
https://developers.openai.com/api/docs/guides/voice-server-controls

[S5] OpenAI, GPT-Live 1 Model / Prompting GPT-Live
https://developers.openai.com/api/docs/models/gpt-live-1
https://developers.openai.com/api/docs/guides/live-prompting

[S6] OpenAI, Data controls in the OpenAI platform
https://developers.openai.com/api/docs/guides/your-data

[S7] Genesys, Audio Connector overview
https://help.genesys.cloud/articles/audio-connector-overview/

[S8] OpenAI, GPT-Live evaluation guide
https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation
