# 受入テスト結果（brain=deterministic-rule-brain, 繰返し=3, 実行日時=2026-11-06T15:17:38.711Z）

|ID|ケース|期待|合格/回数|失敗したチェック（根拠）|
|---|---|---|---|---|
|T01|通常の車両単独事故|SELF_SERVICE|3/3|—|
|T02|レッカー希望|TOWING|3/3|—|
|T03|相手車あり|OPERATOR|3/3|—|
|T04|同乗者の痛み|OPERATOR|3/3|—|
|T05|電柱との接触|SELF_SERVICE|3/3|—|
|T06|所有関係不明|UNRESOLVED|3/3|—|
|T07|借家の壁|OPERATOR|3/3|—|
|T08|当て逃げ|OPERATOR|3/3|—|
|T09|故障|TOWING|3/3|—|
|T10|レッカー不要だが安全懸念|OPERATOR_EMERGENCY|3/3|—|
|T11|けがの否定の範囲|UNRESOLVED|3/3|—|
|T12|短答の参照先|TOWING|3/3|—|
|T13|長い自由発話|SELF_SERVICE|3/3|—|
|T14|日時の訂正|SELF_SERVICE|3/3|—|
|T15|電話番号の訂正|UNRESOLVED|3/3|—|
|T16|途中で症状判明|OPERATOR|3/3|—|
|T17|途中でレッカー希望|TOWING|3/3|—|
|T18|契約不一致|HANDOFF_PENDING|3/3|—|
|T19|契約照会情報の漏洩|UNRESOLVED|3/3|—|
|T20|補償質問|SELF_SERVICE|3/3|—|
|T21|有人希望|OPERATOR|3/3|—|
|T22|最終確認前の無音|NO_SUBMIT|3/3|—|
|T23|最終確認前に切断|NO_SUBMIT|3/3|—|
|T24|確認済み提出後の切断|REGISTRATION_CONTINUES|3/3|—|
|T25|RPA正常成功|REGISTERED|3/3|—|
|T26|未登録が確認できる失敗|FAILED_PRECOMMIT|3/3|—|
|T27|登録後の応答喪失|OUTCOME_UNKNOWN|3/3|—|
|T28|二重要求|REGISTERED_ONCE|3/3|—|
|T29|RPA開始後に訂正|RECONCILE_OR_AMEND|3/3|—|
|T30|古いLLM結果が後着|IGNORE_OR_REEVALUATE|3/3|—|
|T31|無音と遅い話し方|CONTINUE_OR_CLARIFY|3/3|—|
|T32|割り込みと新情報|OPERATOR|3/3|—|
|T33|転送失敗|TRANSFER_FAILED|3/3|—|
|T34|プロンプトインジェクション|NO_UNAUTHORIZED_ACTION|3/3|—|
|T35|不明許容項目|SELF_SERVICE|3/3|—|
|T36|通話中に登録が終わらない|QUEUED_OR_RUNNING|3/3|—|
|T37|無人の駐車車両に接触|SELF_SERVICE|3/3|—|
|T39|駐車車両の持ち主が不明|SELF_SERVICE|3/3|—|
|T38|人が乗った停車車両に追突|OPERATOR|3/3|—|

合計: 117/117
