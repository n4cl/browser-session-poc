# ADR-001: session 単位の broker と明示的な readiness 境界

ステータス: 提案（実装前レビュー待ち）
決定日: 未決定
対象: Browser Session v1 のプロセス境界、所有権、接続、readiness

## 1. Context

PoC は、専用 Chrome/profile、Native Messaging、Extension、pairing、6 browser tool、A/B の storage 分離を macOS の実 Chrome で部分的に成立させた。一方、MCP server の tool 受付開始から Extension/Native Host が `ACTIVE` になる ready 境界は成立せず、決定的 driver の G5-6 は最初の `browser_status` の `transport_closed` で停止した。したがって、MCP の起動や transport open を browser 操作可能性とみなす構成は製品の前提にできない。

本 ADR は、`spike/browser-session-isolation` の次の凍結文書から得た契約だけを入力にする。

- `docs/poc-final-assessment.md`
- `docs/product-reimplementation-handoff.md`

PoC の実装、driver、runtime、profile、手動操作、固定値は移植しない。参照 OSS の採用、依存、配布、license は別途審査する。

## 2. Decision

### 2.1 選択する topology

session ごとに独立した broker process を起動し、その broker に lifecycle supervisor/state machine、MCP/stdio adapter、command router、audit gate、connection fence を持たせる。broker は一つの browser instance と一つの persistent profile だけを明示的に所有する。

```text
agent client (Codex; Claude は採用時に同じ契約)
        │ stdio / versioned broker API
        ▼
session broker
  ├─ lifecycle supervisor (ALLOCATED … CLOSED)
  ├─ MCP adapter / schema / safe result projection
  ├─ command router / identity & fresh-reference gate
  ├─ audit gate / privacy filter
  └─ connection fence / pending request registry
        │ one owned local transport
        ▼
Native Messaging Host
        │ explicit session + instance binding
        ▼
Extension service worker
        │ tabs/debugger operations scoped to owned profile
        ▼
owned Chrome instance + owned persistent profile
```

supervisor は broker と同一 process 内の明示的な責務として実装してよい。将来別 process に分ける場合も、session 単位の ownership、同じ state transition、fail-closed recovery、B への非干渉を失ってはならない。共有 daemon へ責務を移してはならない。

### 2.2 境界ごとの責務

| component | 担当すること | 担当しないこと |
| --- | --- | --- |
| agent client | version negotiation、tool の選択、結果に基づく次の判断 | instance 探索、raw transport 解釈、mutation retry |
| broker/MCP adapter | stdio lifecycle、tools/list、schema 検証、6 tool 受付、safe result/error への写像 | browser/profile の暗黙探索、別 instance fallback、raw CDP 公開 |
| lifecycle supervisor | claim、pairing、generation/lease、readiness、切断、resume、cleanup、state transition | 所有者不明 resource の kill/reuse、未検証の修復 |
| command router | request/response 相関、tab/document/node の ownership/freshness、read-only/mutation admission | mutation の自動 retry、最後に接続した tab の選択 |
| audit/privacy gate | issued/completion audit、privacy negative filter、private file 属性検証 | page content、入力、cookie、raw error の保存 |
| Native Messaging Host | broker と Extension 間の owned local bridge、binding 検証 | session 間 routing、任意の Chrome 探索 |
| Extension | 対象 profile の tabs/debugger 操作、ready signal、fresh document 情報 | 別 profile 操作、秘密値のログ出力、未検証 node の操作 |
| Chrome/profile allocator | instance/profile の確保、ownership claim、終了・回収 | live owner の推測 kill、共有 profile |

### 2.3 transport と所有権

- agent 境界は stdio とする。server process の stdout には protocol message 以外を書かない。診断は privacy-safe な stderr/監視境界へ分離する。
- broker から下流への transport は session 専用の local IPC とし、descriptor/socket/claim の owner、mode、期限、identity を検証する。network listen、shared socket、暗黙の discovery は v1 に含めない。
- 起動時に `session_id`、`browser_instance_id`、`profile_instance_id`、`generation`、`lease_id`、`connection_id` を発行・検証し、request の `request_id` と相関させる。
- 一つの broker は tool 引数で別 instance を指定できない。対応する instance/profile が利用不能なら固定 error を返し、別対象へ補正しない。
- state/claim/audit は private regular file として atomic に更新する。symlink/hardlink、foreign owner、改変、判断不能な stale resource は回収せず fail-closed にする。

### 2.4 readiness の責務

supervisor は `ALLOCATED → PAIRING → ACTIVE → READY → SERVING` を管理し、`READY` になった後だけ mutation を含む tool admission を開く。`READY` は Extension/Host 経路からの identity 相関済み ready signal または bounded probe で証明する。

次は ready の証拠としない。

- broker process が起動した
- stdio initialize や `tools/list` が成功した
- transport が open した
- Chrome PID が存在する
- 過去の generation/connection が ready だった

ready timeout、disconnect、Extension worker/Host/Chrome fault は `DEGRADED` に写像する。送信済み mutation は `outcome_unknown` 相当として再送せず、新規 mutation は拒否する。read-only status の bounded 再確認を許す条件は versioned contract にする。

### 2.5 操作とデータの境界

6 tool は `browser_status`、`tabs_list`、`navigate`、`snapshot`、`click`、`type` に固定し、各 tool の schema、最大サイズ、timeout、認可、audit、error projection を version 管理する。`snapshot` は bounded な構造化データだけを返し、click/type は fresh loader/node を dispatch 前に再検証する。

`navigate`、`click`、`type` は dispatch 後に retry しない。timeout、transport close、completion audit 失敗は結果不確定として扱う。ページ内容、cookie、localStorage、入力 text、認証済み URL、secret、runtime path、PID、raw error は audit、通常ログ、client result に出さない。

## 3. Alternatives considered

| 案 | 判定 | 理由 |
| --- | --- | --- |
| A. session ごとの broker + owned local IPC（採用） | 選択 | stateful pairing/lease/pending mutation を session 単位で保持でき、A/B の fault と routing を自然に分離できる。ready gate を broker admission に置ける |
| B. shared daemon が全 session を管理 | 却下 | shared routing、最後の tab、cross-session response、所有者不明 process の cleanup が混ざりやすい。daemon 障害の blast radius も大きい |
| C. 1 command ごとの短命 CLI | 却下 | pairing、generation、lease、pending mutation、late response fence を command 間で安全に保持できない。stdio/client の quoting と secret 境界も別途増える |
| D. agent から Chrome/CDP へ直接接続 | 却下 | Extension/Native Host の permission・binding・audit 境界を bypass し、profile ownership と session routing を broker が統制できない |
| E. broker が複数 instance を引数で切替 | 却下 | 明示 binding の immutable 性を壊し、入力ミスや prompt 操作で A→B routing を起こし得る |

## 4. Consequences

### Positive

- session→instance→profile の一対一を process、transport、state、audit の単位にできる。
- ready 未成立の race を、tool admission 前の一つの検証可能な境界にできる。
- A の切断、再 pairing、crash、旧 response を B から分離しやすい。
- client adapter を browser core と分離し、Codex/Claude の互換性を個別 matrix で検証できる。
- mutation no-retry と outcome unknown を broker の共通規則として強制できる。

### Costs / trade-offs

- session ごとに process/profile/transport を管理するため、起動・memory・cleanup のコストがある。
- install/update、Extension/Native Host permission、OS/Chrome matrix、依存 license/SBOM を製品工程で解決する必要がある。
- ready signal と再接続を wire contract として設計・テストする必要がある。
- shared daemon のような一元的な長期運用や remote access は意図的に採用しない。

## 5. 不変条件を壊さない実装制約

1. explicit instance/profile 以外を探索しない。
2. owner、lease、generation、connection が不一致なら dispatch/response/cleanup を拒否する。
3. `DEGRADED` から `READY` へ復帰する際は ready を再証明し、古い snapshot を捨てる。
4. cleanup は所有確認済み resource に限り bounded に行う。SIGKILL 後の finally を仮定しない。
5. 監査不能、入力不正、stale resource、privacy filter failure は便利な自動修復より拒否を優先する。
6. PoC のディレクトリ構造、固定 runtime layout、driver 起動方式を設計上の前提にしない。

## 6. 検証で決定を見直す条件

次のいずれかが成立しない場合、実装を拡張して隠すのではなく ADR を再レビューする。

- ready signal が対象 profile/binding に相関できない、または bounded に判定できない
- broker 起動・再接続・crash 後に old response/mutation を安全に fence できない
- A の fault が B の process、pending、profile、audit、client result に波及する
- owned local IPC と private state の owner/mode/atomicity を検証できない
- 実 Codex client で status-only ではなく ready を含む6 tool操作列を再現できない
- 必要な OS/Chrome/installer/permission/license 要件が v1 の脅威モデルを満たさない
