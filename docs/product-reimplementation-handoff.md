# 本実装引き継ぎ仕様

この文書は、[PoC最終評価](./poc-final-assessment.md)で成立した不変条件と未解決境界を入力に、製品をゼロから再設計・再実装するための仕様ブリーフである。PoC source、決定的driver、runtime、Chrome profile、手動手順をコピーするための移行手順ではない。

この文書は法的助言やライセンス保証ではない。参照OSSの採否、依存関係、ライセンス、SBOM、脆弱性、配布条件は製品工程で別途審査する。

## 1. 製品目標と境界

### 目標

1つのagent sessionを、対応する1つのbrowser session、1つのChrome instance、1つのpersistent profileへ、セッション中immutableに束縛する。A/Bを近接並行に操作しても、tab、document、cookie、localStorage、入力、監査結果、復旧状態が相互に混ざらないことを製品の中心不変条件とする。

### 製品で再定義する非目標

PoCで扱わなかった、全CDP domain、bot検知の回避保証、全OS対応、installer・更新、remote browser、shared daemon、長期鍵管理、telemetryは、個別の製品要件・脅威モデル・運用設計なしに暗黙採用しない。[PoC計画の非目標](./poc-plan.md)を参照し、採用する範囲を製品仕様で明示する。

## 2. 根拠と採用境界

### 引き継ぐ判断

- session単位のMCP/broker processとlocal IPCを基本境界とし、共有daemonや暗黙の最後のtabに依存しない。
- browser instanceごとに所有権を検証できる専用profileを割り当て、active中の共有を拒否する。
- Extension、Native Host、broker、Chromeの各境界で同じidentityを検証し、別instanceへのfallbackを禁止する。
- request/responseの相関、generation、lease、旧connection fenceを状態機械として扱う。
- read-onlyとmutationを分離し、mutationの不確定結果を自動再送しない。
- audit・通常ログ・client結果から、URL、title、page content、cookie、localStorage、入力text、raw error、runtime path、PID、secretを除外する。

### 引き継がないもの

PoCの実装ファイル、driverの起動方式、runtime layout、profileの作成方法、手動Chrome操作、実行時の固定値は製品設計へコピーしない。これらは検証を再現するための一時的なPoC境界であり、製品のAPI・保存形式・運用方式ではない。

参照OSSのclone・research notesはGit管理外の調査資料として扱い、製品へコードやライセンス文言を取り込む場合は、出典、変更範囲、ライセンス互換性、NOTICE、SBOMを審査してから決定する。参照したこと自体は、採用許可や法的適合性を意味しない。

## 3. 目標アーキテクチャ

```text
agent client
    ↓ stdio / versioned broker API
session broker / MCP boundary
    ↓ owned local transport
Native Messaging Host
    ↓ explicit binding
Extension service worker
    ↓ chrome.tabs / chrome.debugger
owned Chrome instance + owned persistent profile
```

各sessionは、broker process、Native Host connection、Extension binding、Chrome instance/profileの所有関係を追跡できなければならない。所有者が不明なprocess、descriptor、socket、profileを推測して停止・再利用してはならない。共有daemonへfallbackしない。

製品ではPoCに存在しなかったsupervisorまたは同等のライフサイクル責務を明示し、起動完了とbrowser command受付可能状態を別の状態として管理する。

## 4. Identityと不変条件

### Identity tuple

製品プロトコルのversioned schemaに、少なくとも次の論理項目を含める。値の形式、寿命、発行者、秘密性は製品脅威モデルで確定する。

```text
session_id
browser_instance_id
profile_instance_id
generation
lease_id
request_id
```

### 不変条件

- `session_id → browser_instance_id → profile_instance_id`はsession中immutable。
- responseのidentity、generation、lease、request相関が一致しない場合、結果を破棄しconnectionをfenceする。
- pairing nonce、lease、descriptor、socketは一回利用・期限・所有者を検証し、再利用や曖昧な回収を許可しない。
- 起動順、再接続、A限定の停止、process crashが、Bのphase・pending request・profileへ影響してはならない。
- 明示されたtab・document・node以外へ操作を拡張しない。
- navigation後に古いloader/nodeを再利用しない。fresh snapshotを要求する。
- mutationをtimeout、transport close、送信後の不確定な失敗を理由に自動再送しない。
- 不一致、期限切れ、権限不正、socket不在、改変されたprivate fileはfail-closedにする。

## 5. Readinessを含むライフサイクル

PoCのG5-6で欠けていた境界であり、製品の必須設計項目とする。

1. **ALLOCATED**: sessionとbrowser instance/profileの所有権を確保する。
2. **PAIRING**: generation、lease、descriptor、Native Host、Extension bindingを発行・検証する。
3. **ACTIVE**: identity付きのtransportが接続し、旧connectionがfenceされている。
4. **READY**: Extension/Native Hostが対象profileのbrowser commandsを受け付けられることを、明示ready signalまたはbounded waitで確認する。
5. **SERVING**: READY後だけbrowser toolを受け付ける。readiness確認中はmutationを送信しない。
6. **DEGRADED / DISCONNECTED**: timeout、transport close、Extension worker停止、Chrome停止を固定状態へ写像し、新規mutationを拒否する。
7. **REVOKED / CLOSED**: lease・generation・socket・descriptorを失効させ、bounded cleanupを完了する。再開は同一bindingの安全なresumeまたは新generationの明示pairingとする。

ready signalは、単なるMCP process起動、tools/list完了、Chrome process存在、または過去のACTIVE記録と同一視しない。ready timeout時に、接続依存toolを盲目的に再送してはならない。read-only statusの再確認を許す場合も、回数・時間・disconnect扱いをversioned contractにする。

## 6. Browser tool contract

6 toolの名前はPoCの検証語彙として引き継ぐが、製品ではversioned schema、認可、最大サイズ、タイムアウト、監査要件を別途固定する。

| tool | 契約の要点 | 失敗時の要点 |
| --- | --- | --- |
| `browser_status` | 対象bindingの接続・ready・Chrome利用可能性だけを返す。page contentを返さない。 | disconnect、未pair、not ready、timeoutを固定分類する。raw transport detailを返さない。 |
| `tabs_list` | session/profileに属するtabだけを返す。操作に使うtabの型と所有を検証する。 | tabs API不可、tab取得失敗、過大結果は固定error。無関係なtabへfallbackしない。 |
| `navigate` | 明示tabと検証済みURLに対して一回のnavigation requestを送る。acceptedはload完了を意味しない。 | 入力不正・tab不在は確定error。dispatch後のtimeout/transport closeは`outcome_unknown`相当で再送しない。 |
| `snapshot` | 明示tabのfresh documentから、boundedな構造化snapshotを取得する。raw CDPを返さない。 | stale、debugger、tab、サイズ、detachの失敗を固定errorへ写像する。read-only retryは安全条件内に限定する。 |
| `click` | fresh snapshot由来のtab・loader・node参照を再検証してから一回だけ送信する。 | mutation開始前の不一致は確定error、送信後の不確定な失敗は`outcome_unknown`。自動retryしない。 |
| `type` | fresh snapshot由来の編集対象へ、入力textをrequest内部だけで一回挿入する。textをresult/log/auditへechoしない。 | stale・非編集対象は確定error、送信後の不確定な失敗は`outcome_unknown`。自動retryしない。 |

操作列の受入れは、`browser_status → tabs_list → navigate → bounded read-only snapshot → fresh snapshot由来のmutation → fresh snapshot`のように、readiness確認とmutationを分ける。`loader_id`、`backend_dom_node_id`、`tab_id`等は、数値・文字列の型と安全な範囲をschemaで固定する。

## 7. Error semanticsと相関

製品ではerror schemaをversion管理し、clientへは固定code、safeなboolean、件数だけを返す。PoCで観測した`transport_closed`、`timeout`、`stale_document`、`outcome_unknown`、`audit_unavailable`、`tab_not_found`、`navigation_failed`、debugger系の固定分類は、互換性候補としてレビューする。raw Chrome/CDP/Native Messaging error、stack、URL、title、node本文、入力textは返さない。

最低限の写像を次のように固定する。

- dispatch前の入力・identity・ownership不一致: 確定error、dispatchしない。
- issued auditを完了できない: `audit_unavailable`相当、dispatchしない。
- read-onlyのcompletion audit失敗: safeな固定error、結果を成功扱いしない。
- mutationのdispatch後、timeout、transport close、completion audit失敗: `outcome_unknown`相当、再送しない。
- server close時の未処理read: `transport_closed`相当。未処理mutationは不確定として扱う。
- 遅延・旧generation・別connectionのresponse: pendingへ相関せず破棄し、必要ならtransportをfenceする。

## 8. Audit、privacy、security

### Audit

各browser commandについて、dispatch前の`issued`と完了後の`success`または固定errorを、instance/generation単位のprivate storeへ順序保証付きで記録する。許可する論理項目は、session/browser/profile/generation/request/command/outcome/timestampのような最小集合に限定し、保存schemaをversion固定する。

URL、title、cookie、localStorage、page content、入力text、lease、nonce、host connection、runtime path、PID、raw error、secretはaudit・通常ログ・client結果に含めない。audit fileはregular/private file、所有者、link数、親directory権限、atomic writeを検証し、symlink・hardlink・属性変更・foreign ownerをfail-closedで拒否する。

### Security

- profile、descriptor、socket、manifest、Native Host wrapperの所有者・権限・pathを検証する。
- explicit instance以外の探索、shared daemon fallback、所有者不明processのkillを禁止する。
- URL scheme、credential、control character、サイズ、未知fieldを入力schemaで拒否する。
- secret、cookie、認証済みURL、page textを診断のために保存しない。
- Extension permission、Native Host manifest、配布経路、OS権限、更新経路をthreat modelに含める。
- 監査不能、identity不一致、stale resource状態は、便利な自動修復より安全な拒否を優先する。

## 9. Recoveryとcleanup

正常終了、EOF、SIGTERM、transport close、Chrome/Extension/Native Host fault、broker crashを別状態として扱う。cleanupはboundedに行い、子process、transport、descriptor、claim、socket、audit handleを所有確認後に閉じる。SIGKILLされたprocess自身のfinally cleanupを前提にしない。

次回起動時にのみ、process identity、claim ownership、descriptor期限、socket probe、private file属性を再検証し、安全なstale resourceだけを回収する。live owner、active socket、改変されたfile、判断不能な状態は保持してfail-closedにする。

Aの停止・再接続・再pairing中もBを継続させ、Aの旧responseやmutationをBへ配送しない。resumeは同じbrowser/profile instanceの明示bindingに限り、別instanceへの補正は行わない。

## 10. 製品受入れ基準

次のすべてを、unit/protocol、process、実Chrome、実clientの層別証拠で満たすまで、製品readyとは判定しない。

1. A/Bの専用profile、pairing、起動順反転、旧generation拒否、lease・ownership・停止の安全性。
2. Extension/Native Host/brokerのready signalまたはbounded waitが、browser tool受付より先に成立すること。ready未成立・disconnect・timeoutの固定結果を確認すること。
3. 実Chromeで6 toolをA/B近接並行に実行し、明示tab、fresh loader/node、cookie/localStorage、入力、最終snapshotが相互非混在であること。
4. `navigate`、`click`、`type`が各一回で、timeout・transport close・送信後不確定結果に自動retryしないこと。read-only retryの上限と条件を検証すること。
5. A限定のExtension、Native Host、broker、Chrome fault、crash、resume後もBが継続し、Aが新generationで安全に復旧すること。
6. Codexの実clientでstdio initialize、tools/list、6 toolの全操作列、shutdown/resumeを確認すること。対応を製品要件に含めるなら、Claude Codeでも同じ基準を別端末で検証すること。
7. audit issued/completion、privacy negative test、固定error、response相関、late response fence、cleanupを確認すること。
8. OS、Chrome版、Extension配布、Native Host install/update、権限、依存、license、SBOM、脆弱性、運用runbookをレビュー済みにすること。

Gate 4の実Chrome分離合格は、上記の一部の証拠であり、G5-6の実client E2E合格の代替ではない。G5-6でready境界が未成立のまま停止した事実を、製品受入れの未解決条件として引き継ぐ。

## 11. 工程上の制約と次の成果物

- 本実装はPoC branchからのcopyではなく、versioned protocol、state machine、client adapter、Extension/Native Host実装、受入れtestを新規に設計する。
- 実装前に、ready lifecycle、error schema、audit schema、identity tuple、recovery state machine、client matrixのレビューを完了する。
- 実装後は、機密値を含まない再現可能なacceptance記録と、未実施境界を別文書へ残す。
- research cloneとresearch notesはGit管理外に保ち、採用コードを追加する場合だけ出典・license・NOTICE・SBOMを製品リポジトリへ正式に登録する。

PoCの証拠一覧は[最終評価](./poc-final-assessment.md)、Gate別の根拠は[Gate 5計画](./gate-5-plan.md)、[Gate 4実機結果](./gate-4-results.md)、[Gate 5 G5-6結果](./gate-5-g5-6-results.md)から辿れる。
