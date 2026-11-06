# 車両単独事故STS受付｜Claude Code向け要件パック

これは開発用の要件・テスト資料です。アプリのソースコード、PDF原本、APIキーは含みません。

使い方：このフォルダを作業リポジトリに置き、Claude CodeにCLAUDE_CODE_START.mdを読ませてください。

ファイル：
- REQUIREMENTS.md：業務・会話・API・RPA・評価・実装順の要件。
- CLAUDE_CODE_START.md：開始指示。
- acceptance-cases.json：合成データによるテストケース案。音声素材や実行結果ではありません。
- rpa-job.example.json：モック独自の登録要求例。現行RPAの入力形式ではありません。
- rpa-result.example.json：モック独自の結果例。

確認済み：このパックのファイル生成、JSON構文、ZIPの整合。
未実施：アプリ実装、実API呼出、音声試験、実Genesys/RPA/基幹接続、社内承認。

出典はREQUIREMENTS.md末尾を参照。以前添付された受付スクリプトの抽出テキストは参照していますが、原本PDFは同梱していません。
