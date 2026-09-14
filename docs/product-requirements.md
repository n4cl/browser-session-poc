# Browser Session 本実装要件

文書状態: 実装前レビュー用（提案）
作成日: 2026-09-15（JST）
対象: Browser Session v1 のローカル実装

## 1. この文書の位置付け

本書は、凍結済み PoC の検証結果から製品の要求と受入れ基準を抽出したものである。PoC の source、driver、runtime、profile、手操作手順を移植する設計書ではない。本実装は versioned contract と下記の不変条件を先にレビューし、ゼロから実装する。

根拠は `spike/browser-session-isolation` ブランチの次の凍結文書である。

- `docs/poc-final-assessment.md`: Gate 0〜5 の判定、成立範囲、未解決リスク
- `docs/product-reimplementation-handoff.md`: 引き継ぐ判断、identity、error、audit、recovery の契約候補

これらの文書は証拠と制約の入力であり、製品の実装許可、依存の採用許可、OS・Chrome・ライセンスの保証ではない。

## 2. 製品目標と用語

### 2.1 目標

agent session 1つを、browser session 1つ、Chrome instance 1つ、persistent profile 1つへセッション中 immutable に束縛する。複数 session を近接並行に操作しても、tab、document、cookie、localStorage、入力、監査結果、復旧状態を相互に混在させない。

### 2.2 用語

| 用語 | 定義 |
| --- | --- |
| session | agent client から見える、1回の browser 操作単位 |
| broker | session ごとに起動する MCP/stdio 境界。browser command の受付、相関、結果の安全な写像を担当する |
| browser instance | session が所有する Chrome process 集合とその instance identity |
| profile instance | browser instance 専用の persistent profile。別 session と共有しない |
| binding | broker、Native Messaging Host、Extension、Chrome instance/profile を identity 付きで結ぶ関係 |
| ready | 対象 profile の browser command を安全に受け付けられることを実際に確認した状態 |
| mutation | `navigate`、`click`、`type` のように browser state を変更し得る command |
| read-only | `browser_status`、`tabs_list`、`snapshot` のように state を読み取る command（snapshot の取得は bounded とする） |
| outcome unknown | dispatch 後に timeout、transport close、完了監査失敗などが起き、実行結果を確定できない状態 |

## 3. 範囲

### 3.1 v1 で扱う範囲

- session 単位の broker と、broker が明示的に所有する local transport
- Native Messaging Host、Extension service worker、専用 Chrome instance、専用 persistent profile の binding
- session/profile/instance/generation/lease/request の identity と response 相関
- readiness を含む起動、接続、切断、再接続、終了、stale resource 回収
- `browser_status`、`tabs_list`、`navigate`、`snapshot`、`click`、`type` の versioned tool contract
- A/B 近接並行、起動順反転、A 限定 fault、crash/resume、old response の isolation test
- privacy-safe audit、固定 error、diagnostic data minimization
- Codex 実 client の stdio initialize、tools/list、6 tool 操作列、shutdown/resume

Claude Code を v1 の必須 client とするかは、client matrix のレビューで明示的に選択する。採用する場合は Codex と同じ受入れ基準を別環境で満たす。

### 3.2 非目標（別途承認が必要）

- 全 CDP domain の公開
- bot 検知の回避や、サイトの利用規約・policy への適合保証
- remote browser、共有 daemon、複数 agent が同じ profile を使う運用
- Windows/Linux、複数 Chrome channel、installer/update の一般化（release matrix で追加するまで）
- 長期鍵管理、telemetry、ページ内容・cookie・認証情報を含む中央収集
- PoC source/driver/runtime/profile/manual flow の再利用

## 4. 不変条件（全要件に優先）

1. `session_id → browser_instance_id → profile_instance_id` は session 中 immutable である。
2. broker は起動時に対象を1つだけ束縛し、tool 引数から別 instance を選択・探索・fallback できない。
3. response の session、instance、profile、generation、lease、request 相関が一致しなければ結果を利用せず、必要に応じて connection を fence する。
4. 所有者・期限・nonce・descriptor・socket・profile が検証できない場合は停止、再利用、回収をしない（fail-closed）。
5. 明示された tab、fresh document、検証済み node 以外へ操作を拡張しない。
6. navigation 後に古い loader/node を再利用しない。mutation は dispatch 後の不確定な失敗を自動 retry しない。
7. A の停止、再接続、再 pairing、process crash は B の phase、pending request、profile、結果配送へ影響しない。
8. URL、title、page content、cookie、localStorage、入力 text、raw error、runtime path、PID、secret を audit、通常ログ、client result に保存・返却しない。

## 5. 機能要件

優先度は `MUST`（リリースブロッカー）、`SHOULD`（v1 推奨）、`MAY`（将来候補）で表す。

| ID | 優先度 | 要件 | 受入れの観測 |
| --- | --- | --- | --- |
| FR-001 | MUST | session の allocation 時に、専用 browser instance/profile の ownership claim を原子的に確保する | A/B の同時 allocation、二重 claim、foreign owner を試し、共有・曖昧な claim が拒否される |
| FR-002 | MUST | broker、Host、Extension、Chrome/profile の全境界で同じ binding identity を検証する | 起動順反転、別 instance、old generation、期限切れ lease の response/接続を拒否する |
| FR-003 | MUST | pairing を generation、lease、nonce、descriptor、connection identity 付きで行い、旧 binding を fence する | 再接続・再 pairing 後の late response が pending request に相関せず、B に配送されない |
| FR-004 | MUST | browser command の受付を `READY` 以降に限定し、ready signal または bounded wait が完了するまで mutation を送らない | Chrome process の存在や MCP 起動だけでは ready にならず、ready timeout/disconnect は固定結果になる |
| FR-005 | MUST | 6 tool を versioned schema、認可、入力サイズ、timeout、audit の対象として実装する | tools/list と各 tools/call の schema、固定 error、issued/completion audit を層別に検証する |
| FR-006 | MUST | `tabs_list` と全 mutation は session/profile ownership を検証し、暗黙の「最後の tab」を使わない | A/B の tab 一覧・tab id を比較し、明示 tab 以外への操作が不可能である |
| FR-007 | MUST | `snapshot` は bounded な fresh document 参照を返し、click/type はその参照を dispatch 前に再検証する | navigation、DOM mutation、stale loader/node で `stale_document` 相当を確認する |
| FR-008 | MUST | `navigate`、`click`、`type` は一回送信とし、dispatch 後の timeout/close/完了監査失敗を `outcome_unknown` 相当として再送しない | server/client/Host/Chrome の各切断位置で mutation 回数が1回以下である |
| FR-009 | MUST | A の Extension、Host、broker、Chrome fault と resume を個別に扱い、B は継続する | A fault 中に B の read-only と mutation を継続し、A は明示した新 generation で復旧する |
| FR-010 | MUST | 正常終了、EOF、SIGTERM、transport close、依存 component fault、broker crash を区別し、cleanup を bounded に行う | SIGKILL 後の次回起動で安全な stale resource のみ回収し、live/改変/判断不能は保持する |
| FR-011 | MUST | issued と completion（success または固定 error）を instance/generation 単位の private audit に順序保証付きで記録する | audit 不可時は command を dispatch せず、completion 不可時は成功扱いしない |
| FR-012 | MUST | client へ安全な boolean、code、件数だけを返し、raw transport/CDP/stack を境界外へ漏らさない | privacy negative test と unknown field/raw error の拒否を確認する |
| FR-013 | MUST | broker process は session ごとに独立し、共有 daemon や所有者不明 process の kill/fallback を禁止する | A の PID/socket/transport と B のものを取り違えられない |
| FR-014 | MUST | URL scheme、credential、control character、未知 field、最大サイズ、tab/document/node の型・範囲を schema で検証する | 不正入力は dispatch 前の確定 error となり、audit と結果に secret/text が出ない |
| FR-015 | MUST | Codex 実 client の stdio initialize、tools/list、6 tool 全操作列、shutdown/resume を実環境で記録する | status-only を合格とせず、ready signal と最終 snapshot を含む操作列が成立する |
| FR-016 | SHOULD | client adapter の protocol version negotiation と最小対応 version を明示する | version 不一致を安全な固定 error へ写像し、未知 extension を無視または拒否する規則が再現できる |
| FR-017 | SHOULD | 機密値を含まない再現可能な受入れ記録と運用 runbook を提供する | 実行時刻、matrix、判定、未実施境界、復旧手順だけで結果を再確認できる |
| FR-018 | MAY | Claude Code を対応 client として追加する | Codex と同じ client acceptance を別端末・別 account 境界で満たす |

## 6. Tool contract の共通規則

### 6.1 共通 request

tool 引数は session ID や instance ID を自由入力として受け取らず、broker の起動時 binding に暗黙固定する。各 request は version、request_id、command、bounded arguments、期待する generation を持つ。broker は dispatch 前に identity、ownership、permission、audit issued の順で検証する。

### 6.2 共通 result/error

成功 result は schema で許可した構造化データだけを返す。失敗は固定 `code`、safe な `retryable`、必要最小限の `phase`/`count` に限定し、raw detail は server log にも保存しない。少なくとも以下を互換候補としてレビューし、最終 code と version を protocol 文書で固定する。

| 分類 | 意味 | 自動 retry |
| --- | --- | --- |
| `not_paired` / `not_ready` | binding または ready 条件が未成立 | mutation は不可。read-only status の bounded 再確認のみ許可 |
| `transport_closed` | transport が閉じた | 不可 |
| `timeout` | bounded timeout に達した | mutation 不可。安全条件付き read-only のみ |
| `stale_document` | fresh loader/node 参照と一致しない | 不可。新 snapshot を要求 |
| `outcome_unknown` | dispatch 後の実行結果を確定できない | 不可 |
| `tab_not_found` / `navigation_failed` | 対象 tab/operation の確定失敗 | 不可（入力修正を要求） |
| `audit_unavailable` | required audit を完了できない | command を dispatch しない |

### 6.3 6 tool の操作契約

- `browser_status`: binding、transport、ready、Chrome 利用可否の boolean/分類だけを返す。ページ内容を返さない。
- `tabs_list`: owned session/profile に属する tab の bounded 一覧だけを返す。別 profile への fallback はしない。
- `navigate`: 明示 tab と検証済み URL に一回 dispatch する。accepted は load 完了を意味せず、completion の状態を別に返す。
- `snapshot`: 明示 tab の fresh document から bounded 構造化 snapshot を取得する。raw CDP は返さない。
- `click`: fresh snapshot 由来の tab/loader/node を再検証し、一回だけ dispatch する。
- `type`: fresh snapshot 由来の編集対象を再検証し、入力 text を request 内だけで一回適用する。text は result/log/audit に echo しない。

受入れ操作列は、`browser_status → tabs_list → navigate → bounded read-only snapshot → fresh snapshot 由来の mutation → fresh snapshot` とする。status-only や MCP initialize の成功は、実 Chrome 操作の合格を意味しない。

## 7. 非機能要件とデータ分類

| 分類 | 要件 |
| --- | --- |
| 安全性 | identity/ownership/audit/ready が確認できない場合は fail-closed。別 instance の補正・探索・kill をしない |
| 分離 | A/B の process、transport、pending request、profile storage、tab/document、audit sequence を独立させる |
| 信頼性 | timeout、EOF、切断、fault、crash、resume を固定状態へ写像し、cleanup と stale 回収に上限を設ける |
| 冪等性 | read-only の retry 条件だけを定義し、全 mutation は送信後 retry なし |
| 互換性 | protocol/tool/error schema を version 固定し、client/Chrome/OS matrix と最低対応 version をリリースごとに記録する |
| 監査性 | issued と completion の相関、順序、判定を機密値なしで再構成できる |
| プライバシー | page content、認証済み URL、cookie/localStorage、入力、secret、PID/runtime path をログ・audit・client result に含めない |
| 運用性 | install/update、権限、依存 license/SBOM、脆弱性、監視、runbook を実装完了の別 gate としてレビューする |

## 8. 受入れ基準と証拠

製品 ready は、以下をすべて満たしたときだけ宣言する。層の異なる証拠を代替扱いしない。

1. unit/protocol: identity、schema、state transition、固定 error、相関、old response fence、audit privacy、no-retry。
2. process/lifecycle: stdio EOF、SIGTERM、transport close、component fault、crash 後の bounded cleanup/stale 回収。
3. 実 Chrome: A/B 専用 profile、pairing、起動順反転、6 tool、fresh loader/node、storage/input 分離、A fault 中の B 継続。
4. 実 client: Codex の initialize/tools/list、readiness 確認、6 tool の全操作列、shutdown/resume。Claude を要件化する場合は同じ証拠を追加。
5. operation/package: 対応 OS/Chrome matrix、Extension/Host install/update、権限、依存 license、SBOM、脆弱性、runbook。

各証拠は、client、OS、Chrome channel/version、起動順、A/B 同時性、実行回数、観測結果、未実施範囲を記載し、機密値を含めない。`NOT TESTED` と `PARTIAL` を `PASS` に丸めない。

## 9. 未解決事項（実装前レビューで決める）

- v1 の対応 OS、Chrome channel/version、Extension の配布方式、Native Host の install/update 権限
- ready signal の発行者、payload、bounded wait の timeout/backoff/回数、再接続後の ready 再確立条件
- identity 各値の形式、発行者、寿命、秘密性、lease renewal/rotation の期限
- snapshot の許可フィールド、最大サイズ、document/node 参照の有効期限
- error schema/version、client ごとの結果互換、Claude Code の必須可否
- profile/descriptor/socket/audit store の配置、権限、atomic write、stale 回収ポリシー
- 実装の依存候補、ライセンス、SBOM、脆弱性評価（採用前に別途レビュー）
