# 要件と実装の対応

要件の原文は [requirements/](../requirements/)（Takaさん提供の要件パック。JSONはモック独自のサンプル）。

|要件（REQUIREMENTS.md）|実装|状態|
|---|---|---|
|§3.1 判定項目 yes/no/unknown/conflict|`server/src/domain/catalog.ts`, `routing.ts`（`tri`）|Mock検証済|
|§3.2 優先順位（緊急>レッカー>有人>非対象>確認>対象）|`decideRoute`|Mock検証済（T02,T09,T10,T21）|
|§3.3 相手なし≠第三者物なし、自宅≠自己所有、賃貸（D11で公共物・無人の駐車車両をSTS対象に変更）|`decideRoute` + Brain抽出規則|Mock検証済（T03,T05〜T08,T37〜T39）|
|§3.4 途中変更で再判定・旧権限失効|`SessionController.applyPlan/onFactsChanged/ensureTransfer`|Mock検証済（T16,T17,T32）|
|§4 固定質問キューなし・LLMが順序選択|`OpenAIBrain`（next_intent/suggested_speech）|**実API未検証**|
|§4 短答は直前の実発話に照合|Brainにはspoken発話のみ渡す（planned除外）|Mock検証済（T12）|
|§5.2 GPT-LiveとRealtimeを混同しない|`server/src/live/liveAdapter.ts`|**実API未検証**|
|§5.3 base_state_version / watermark / analysis_id|`requestAnalysis/applyPlan`|Mock検証済（T30,T31）|
|§5.4 完了案内は確認済みRegistrationResultに限定|`ActionGate.canAnnounceComplete`|Mock検証済（T25,T27）|
|§7 Fact（value/status/origin/evidence/原発話/履歴）|`domain/types.ts`, `facts.ts`|Mock検証済（T14）|
|§7.2 通話/受付/登録の状態を分離|`Conversation`|Mock検証済（T24）|
|§8 契約未特定→HANDOFF_PENDING、2項目一致≠本人認証|`PolicyAdapter`, `checkHandoffPending`|Mock検証済（T18,T19）|
|§8 転送パッケージ・転送完了前に言わない・失敗で切断しない|`TelephonyAdapter`, `requestTransfer`|Mock検証済（T02,T33）|
|§9.2 ジョブメタデータ|`RpaJob`|Mock検証済|
|§9.3 登録前条件・無音は同意でない|`ActionGate.canAcceptConfirmation/canSubmitRegistration`|Mock検証済（T22,T34）|
|§9.4 重複・訂正|`RpaAdapter.submit/cancel`, `MockCore`|Mock検証済（T28,T29）|
|§9.5 通話切断|`endCall`|Mock検証済（T23,T24）|
|§9.6 失敗（PRECOMMIT/UNKNOWN/DELAYED/FIELD_ERROR）|MockWorker, `onJobUpdate`|Mock検証済（T26,T27,T36）。FIELD_ERRORは有人引継ぎで簡略化|
|§11 モックUI・障害注入|`client/src/App.tsx`|画面動作は手動確認|
|§12 キーはサーバ、認証なしで公開しない、ログ期限|`config.ts`, `auth.ts`, `index.ts`|ローカルで確認済|
|§6 条件付き項目（免許・飲酒等）|未実装（規程未取得）|未実装|
