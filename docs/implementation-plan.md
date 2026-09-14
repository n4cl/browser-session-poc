# Browser Session 本実装作業計画

文書状態: 実装前レビュー用（提案）
作成日: 2026-09-15（JST）
前提: PoC branch は凍結済み。本計画では PoC のコード・driver・runtime・profile をコピーしない。

## 1. 進め方の原則

- 実装より先に protocol、identity、readiness、error、audit、recovery の契約をレビューして凍結する。
- broker、Native Host、Extension、Chrome/profile の各層を独立して検証し、層をまたぐ証拠を代替扱いしない。
- mutation は dispatch 後に再送しない。read-only の再確認だけを bounded な規則で許可する。
- A/B、起動順反転、A 限定 fault、crash/resume、late response を常に同じ isolation 基準で評価する。
- 依存追加・OSS 採用・配布方式は、候補の保守状況、互換性、license、SBOM、脆弱性をレビューしてから決める。
- 受入れ記録には機密値を含めず、`PASS`、`PARTIAL`、`NOT TESTED`、`FAIL` を明確に分ける。

## 2. 実装前の決定事項（Gate 0）

以下を未決のままコードを書き始めない。

| 項目 | 決めること | 成果物 / 完了条件 |
| --- | --- | --- |
| product boundary | v1 の OS、Chrome channel/version、対応 client（Codex、Claude の要否）、非目標 | versioned support matrix と承認記録 |
| identity | session/browser/profile/generation/lease/connection/request の形式、発行者、寿命、秘密性 | protocol schema、sequence diagram、拒否テスト |
| readiness | signal 発行者、wire payload、probe の安全性、deadline、backoff、再接続条件 | lifecycle contract、timeout/error table、state transition test |
| error | `not_ready`、`transport_closed`、`timeout`、`stale_document`、`outcome_unknown` 等の code と safe projection | error schema/version、client mapping |
| audit/privacy | issued/completion fields、sequence、private store 属性、漏えい禁止フィールド | audit schema、privacy negative test、store policy |
| recovery | normal/EOF/SIGTERM/close/fault/crash の差、stale 回収判定、bounded cleanup | recovery state machine、runbook skeleton |
| packaging/security | Extension permission、Host install/update、権限、署名、依存 license/SBOM、threat model | security/package review の sign-off |

Gate 0 の未決事項は、実装中に暗黙の default で埋めず、変更記録を残して再承認する。

## 3. 段階的な work breakdown

### Phase 1: 契約と安全基盤

成果物:

- versioned request/response/error/audit schema
- immutable identity と ownership claim の仕様
- `ALLOCATED`〜`CLOSED` の state machine と transition guard
- private state/audit file の owner、mode、atomic write、stale 判定仕様
- test vectors（正常、不一致、期限切れ、改変、unknown field、サイズ超過）

完了条件:

- unit/protocol test で相関、old generation/connection fence、unknown field、privacy filter、audit gate、mutation no-retry を検証できる。
- schema は raw CDP、page content、cookie/localStorage、input text、secret、PID/runtime path を result/audit/log に許可しない。

### Phase 2: session broker と supervisor

成果物:

- session ごとの stdio broker entry point と protocol version negotiation
- supervisor の `ALLOCATED → PAIRING → ACTIVE → READY → SERVING` admission
- connection/pending registry、fixed error projection、bounded timeout
- normal shutdown、EOF、SIGTERM、transport close の lifecycle

完了条件:

- `tools/list` 成功を ready と誤認しない。
- ready 未成立時の mutation dispatch 数が0で、read-only status probe の回数・時間が上限内である。
- stdout は protocol のみで、診断出力と secret が混ざらない。

### Phase 3: owned local transport と pairing

成果物:

- broker—Native Host 間の session 専用 local transport
- nonce、descriptor、lease、generation、connection の発行/検証/fence
- Extension との explicit binding handshake
- disconnect、late response、再接続の protocol test

完了条件:

- 別 instance、別 owner、期限切れ、改変 descriptor、old generation/connection を fail-closed で拒否する。
- A の切断/reconnect 中も B の pending/result/audit に A の値が出ない。

### Phase 4: Extension と browser adapter

成果物:

- 対象 profile での ready signal
- tabs/document の ownership と fresh reference 管理
- 6 tool（status/tabs/navigate/snapshot/click/type）の adapter と bounded response
- stale document、tab not found、navigation failure、debugger fault の固定写像

完了条件:

- `ACTIVE → READY` は対象 binding の signal/probe 成功後だけ成立する。
- navigation 後に loader/node を再利用せず、click/type は fresh snapshot 由来の参照を一回だけ送る。
- mutation dispatch 後の timeout/close/completion audit failure は `outcome_unknown`、retry なし。

### Phase 5: Chrome/profile allocator と recovery

成果物:

- 専用 instance/profile の allocation/release と ownership claim
- Chrome/Host/Extension fault の検出・状態写像
- crash/SIGKILL 後の次回起動時 recovery と安全な stale 回収
- A/B isolation と storage marker の実 Chrome acceptance fixture

完了条件:

- A/B の専用 profile、cookie/localStorage、tab、入力が混ざらない。
- A の Host/Extension/broker/Chrome 停止後も B が継続し、A は同じ instance の新 generation でのみ復旧する。
- live owner、active socket、改変/判断不能 file を回収しない。

### Phase 6: 実 client と配布・運用

成果物:

- Codex の stdio initialize、tools/list、ready、6 tool、shutdown/resume の acceptance 記録
- Claude を対応する場合の別環境 matrix と記録
- install/update/rollback、権限変更後の復旧、監視、incident/runbook
- OS/Chrome/client/Extension/Host/version の release matrix、license/NOTICE/SBOM、脆弱性評価

完了条件:

- status-only や protocol smoke を実 Chrome E2E 合格の代替にしない。
- 各 matrix 行に実行結果と未実施境界があり、ready 未成立の操作列を `PASS` としない。

## 4. 検証マトリクス

| 層 | 主な試験 | 必須証拠 |
| --- | --- | --- |
| unit | schema、identity、state guard、error mapping、privacy、no-retry、file permission | test result と version |
| protocol | stdio framing、tools/list/call、audit issued/completion、late response、old fence | sanitized transcript |
| process | Host/Extension/broker/Chrome start order、EOF、SIGTERM、close、SIGKILL、stale recovery | process/lifecycle report（PID は保存しない） |
| real Chrome | A/B profile、同一 origin storage、tab/document、navigate/snapshot/click/type、A fault/B 継続 | OS/Chrome matrix 付き acceptance report |
| real client | Codex full sequence、shutdown/resume、Claude（採用時） | client-specific report と raw secret-free result |
| operation/package | install/update、permission、署名、rollback、SBOM、license、脆弱性、runbook | release readiness checklist |

各層で最低限、A→B/B→A 起動順、near-concurrent 操作、A ready timeout、A 限定 fault、old response を実行する。実機未実施は protocol/synthetic の成功から推定しない。

## 5. Release gate

実装・検証は次の gate を順番に通す。

1. **G0 Contract freeze**: 上記の実装前決定事項と threat model が承認済み。
2. **G1 Broker readiness**: broker の state machine、ready admission、固定 error、stdout/privacy が unit/protocol で合格。
3. **G2 Pairing isolation**: owned local transport、generation/lease/fence、A/B 起動順反転が process test で合格。
4. **G3 Browser operations**: 実 Chrome 6 tool、fresh reference、no-retry、storage/input isolation が合格。
5. **G4 Fault and recovery**: A 限定 fault、B 継続、crash/stale recovery、cleanup boundedness が合格。
6. **G5 Client compatibility**: Codex の全操作列、対応する場合は Claude の全操作列が ready を含めて合格。
7. **G6 Production readiness**: package/permission/update、OS/Chrome matrix、license/SBOM/vulnerability、運用 runbook が承認済み。

どれか一つでも未達なら製品は `NOT READY`。部分的に確認できた場合は `PARTIAL` とし、未実施は `NOT TESTED` と記録する。PoC の Gate 4 isolation 合格は G3 の一部証拠であり、G5 の代替ではない。

## 6. 作業単位と変更管理

実装リポジトリでは、契約・state machine・各 adapter・テスト・package/運用を目的単位で分け、各単位に対応する review と commit を作る。各 commit は変更目的だけを記し、PoC branch の source/driver/runtime の取り込みを行わない。

本ブランチでの本設計は docs-only とし、実装コード・依存関係・PoC 生成物は追加しない。`/.runtime/`、`/node_modules/`、`/research/` はローカル調査・実行状態として保持するが、Git 管理へ追加しない。

## 7. 主なリスクと対処

| リスク | 早期検知 | 対処 |
| --- | --- | --- |
| ready race が再発 | 最初の status/operation が `transport_closed`/`timeout` | tool admission を閉じ、signal/probe と bounded wait を先に修正。mutation を再送しない |
| old response が新 binding に混入 | generation/connection mismatch の test failure | fence を connection 単位にし、pending を閉じて再 pairing。fallback しない |
| A fault の B 波及 | B の phase、audit sequence、result に A の変化 | ownership/transport/state を session 単位に戻し、共有 resource を禁止 |
| stale resource の誤回収 | owner/lease/file attribute の曖昧なケース | 回収せず `REVOKED`。安全な stale と証明できる条件を狭く保つ |
| client ごとの解釈差 | Codex/Claude の schema/result/error 差 | adapter mapping と client matrix を独立で固定。status-only を合格扱いしない |
| privacy 漏えい | fixture の URL/content/input/raw error が記録される | boundary filter と negative test を gate 化し、audit store を fail-closed にする |
| 配布・更新の未検証 | install/update/permission matrix が空欄 | G6 を通るまで製品 ready を宣言しない |

## 8. 参照と完了報告

完了報告には、変更ファイル、作業単位ごとの commit、各 gate の判定、使用した client/OS/Chrome matrix、未実施範囲、残余リスクを記載する。証拠に機密値・ページ内容・入力 text・PID・runtime path を含めない。
