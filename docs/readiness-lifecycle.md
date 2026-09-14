# Browser Session readiness lifecycle

文書状態: 実装前レビュー用（提案）
作成日: 2026-09-15（JST）

## 1. 目的

PoC で実 Chrome への最初の `browser_status` が `transport_closed` で停止したことから、MCP server の起動、Chrome process の存在、Native Messaging の接続を browser command の受付可能性と同一視しない。本書は、browser tool を受け付ける境界を `READY` として明示し、readiness 失敗・切断・再接続・crash を決定的に扱うための状態契約である。

ready の成立は「transport が open」「Chrome が process table にある」「`tools/list` が返る」だけではない。対象 profile の Extension/Native Host が、対象 binding の identity を検証したうえで browser command を受け付け、結果を返せることを確認できなければならない。

## 2. 状態モデル

| 状態 | 意味 | browser command | 退出条件 |
| --- | --- | --- | --- |
| `ALLOCATED` | session と専用 browser/profile の ownership claim を確保済み | 受付不可 | 必要な descriptor/config を検証して `PAIRING`、または失敗して `REVOKED` |
| `PAIRING` | generation、lease、nonce、descriptor、Host、Extension binding を発行・検証中 | 受付不可 | identity/ownership が揃えば `ACTIVE`、期限/不一致なら `REVOKED` |
| `ACTIVE` | identity 付き transport が接続済み。旧 connection は fence 済み | status/readiness probe のみ | probe 成功で `READY`、timeout/close で `DEGRADED` |
| `READY` | 対象 profile の browser command を bounded な契約で受付可能であることを証明済み。新規 request の admission 境界が開いている | 新規 request を admission 判定する。admission 通過後は `SERVING` サブ状態で処理する | fault/timeout で `DEGRADED`、正常終了で `CLOSED` |
| `SERVING` | `READY` の lifecycle 内で admission 済み request を処理中の内部サブ状態 | 追加 request も `READY` の admission を通す。処理中 request の状態を追跡する | request 完了後、未完了 request がなければ `READY`。fault で `DEGRADED` |
| `DEGRADED` | 接続、ready、Chrome、Extension、Host のいずれかが利用不能/不確定 | 新規 mutation は拒否。status と安全な read-only 再確認のみ | 同一 instance の安全な再接続で `ACTIVE`、期限/所有喪失で `REVOKED`、終了で `CLOSED` |
| `REVOKED` | lease/generation/socket/descriptor が失効。再利用不可 | 受付不可 | bounded cleanup 後 `CLOSED`。再開は新しい明示 pairing |
| `CLOSED` | session が終了し、所有 resource の close を完了 | 受付不可 | 終端 |

`SERVING` は独立した readiness ではなく `READY` の内部 request-processing サブ状態である。`READY` は新規 request を admission できる状態、`SERVING` は admission 済み request の処理状態として区別する。複数 request の同時実行、同一 session 内の read-only 並行数、mutation と read-only の相互排他、queue/reject の規則は本設計では未決であり、Gate 0 で固定する。それまでは安全側の実装候補として「session あたり mutation は1件まで、admission 中の新規 mutation は拒否し、read-only の並行数も明示上限を設ける」を採用する。

## 3. identity と state record

各状態遷移と request の envelope に、少なくとも次の論理項目を含める。

```text
session_id
browser_instance_id
profile_instance_id
generation
lease_id
connection_id
request_id
```

値の形式、発行者、寿命、秘密性、永続化方式は実装前レビューで固定する。`request_id` は一つの操作の相関用で、retry の許可を意味しない。

状態 record の更新は、所有者・世代・lease を検証してから atomic に行う。外部から変更された record、symlink/hardlink、foreign owner、期限切れ lease、判断できない lock は fail-closed とする。process 自身が SIGKILL 後に cleanup できることを前提にしてはならない。

## 4. 遷移とガード

### 4.1 起動

```text
ALLOCATED
  -> PAIRING       claim/descriptor/permission を検証
  -> ACTIVE         matching identity の transport を確立
  -> READY          explicit ready signal または bounded readiness probe が成功
READY
  -- admit(request) -> SERVING  admission 済み request の内部処理サブ状態
SERVING
  -- complete       -> READY     未完了 request がなければ admission を継続
```

各矢印のガード:

1. `ALLOCATED → PAIRING`: session、instance、profile の一対一 claim が存在し、broker が所有すること。既存 live owner や共有 profile は拒否する。
2. `PAIRING → ACTIVE`: nonce、generation、lease、descriptor、Host、Extension が同じ binding を示し、old connection を fence できること。別 instance への補正はしない。
3. `ACTIVE → READY`: ready signal は対象の `session_id`、`browser_instance_id`、`profile_instance_id`、generation、lease、connection に相関し、対象 profile 上で command probe（または同等の bounded readiness check）が成功すること。MCP initialize、`tools/list`、Chrome PID のみの成功は不十分。
4. `READY -- admit(request) → SERVING`: version、schema、permissions、audit store、request admission が利用可能であること。admission を通過した request だけを処理し、同時実行の上限・queue/reject は Gate 0 で凍結する。ready 確認中の mutation はキューに溜めず拒否する。

### 4.2 通常処理

`READY` で新規 request を受け、admission を通過した request を `SERVING` の内部サブ状態として処理するとき、次の順に行う。受信直後に fault が発生し `READY` でなくなった場合は、admission を原子的に失敗させる。

1. broker 起動時 binding と request envelope の version/identity を照合する。
2. 引数の型、サイズ、URL scheme、tab/document/node の有効範囲、未知 field、権限を検証する。
3. issued audit を private store に順序保証付きで記録する。失敗したら `audit_unavailable` 相当で停止し、dispatch しない。
4. read-only または mutation の admission を判定する。lifecycle が `READY` でない場合、または Gate 0 で定める同時実行上限を超える場合は mutation を dispatch しない。admission 成功時に request を `SERVING` として登録する。
5. 対象 tab を明示し、snapshot 由来の loader/node 参照を再検証する。
6. response が同じ request、connection、generation、lease に相関することを確認する。遅延/旧 response は pending に結び付けず破棄し、必要なら connection を fence する。
7. completion audit を記録する。完了監査が失敗した場合、mutation は成功扱いせず `outcome_unknown` 相当とする。request を `SERVING` から完了へ収束させ、未完了 request がなければ lifecycle の admission は `READY` のまま継続する。

### 4.3 ready failure / disconnect

以下はいずれも `DEGRADED` へ遷移させる。

- ready signal が bounded deadline までに来ない
- ready signal の identity、generation、lease、connection が不一致
- transport close、Native Host exit、Extension worker stop
- 対象 Chrome/profile の停止または ownership 喪失
- required audit の書き込み・完了検証が不可能
- response の相関不一致、改変 descriptor、権限不正

`DEGRADED` では、送信済み mutation の結果を `outcome_unknown` として扱い、再送しない。新規 mutation は `not_ready`、`transport_closed`、`timeout` 等の固定 error に写像する。read-only の再確認を許す場合は、最大時間・回数・backoff・相関条件を versioned contract にし、probe 自体が mutation にならないことを確認する。

### 4.4 再接続 / resume

1. `DEGRADED` へ入った connection は fence し、pending request を connection 単位で閉じる。
2. 同じ browser/profile instance を再利用できるか、claim、descriptor、socket、lease、process owner を再検証する。所有が不明なら回収・再利用しない。
3. 安全な場合のみ新しい `generation` と `connection_id` を発行して `PAIRING` へ戻る。旧 generation の response と mutation は無効である。
4. `ACTIVE → READY` を最初からやり直す。過去の ready 記録を現在の ready の代用にしない。
5. `READY` 復帰後、古い snapshot の loader/node を使わず、read-only `tabs_list`/`snapshot` から操作列を再構築する。

resume 中に別 instance/profile へ切り替えない。未完了 mutation の再送ではなく、client に不確定結果を返して次の操作判断を委ねる。

### 4.5 終了 / crash recovery

正常終了、stdio EOF、SIGTERM、transport close、component fault、broker crash を audit/metrics 上で区別する。

- 正常終了/EOF/SIGTERM: admission を閉じ、pending を固定結果へ収束させ、所有確認後に transport、descriptor、claim、socket、audit handle、子 process を bounded に閉じる。
- transport/component fault: `DEGRADED` とし、送信済み mutation は不確定。B 等の別 session は変更せず継続させる。
- broker crash/SIGKILL: 次回起動の recovery だけが stale 回収を試みる。live owner、active socket、改変 file、期限を判断できない resource は保持して `REVOKED` 相当にする。
- `REVOKED`: cleanup の再試行は所有確認後に限定し、終了時刻を過ぎた無限待機をしない。再開は新 generation の明示 pairing とする。

## 5. readiness signal 契約（提案）

ready signal の最終 wire format は protocol review で決めるが、次を必須とする。

| 項目 | 要件 |
| --- | --- |
| 発行者 | 対象 profile の Extension/Native Host 経路。broker 起動や client の tools discovery ではない |
| 相関 | session、browser/profile instance、generation、lease、connection を含め、現在の binding と完全一致させる |
| 意味 | 対象 profile で browser command を受付・返信でき、required permission と audit が有効であること |
| 範囲 | browser の全機能や page load 完了を意味しない。tool ごとの completion は別契約 |
| timeout | deadline、probe 回数、backoff、最終 error、再接続可否を固定する。無限待機しない |
| 再接続 | connection/generation が変わったら ready を再証明する。過去の signal を再利用しない |
| 失敗 | `not_ready` または `timeout` 等の固定 error。mutation を盲目的に送信しない |

ready は全 tool の無制限な成功を約束するものではない。`tabs_list`、snapshot、navigation、click、type は、それぞれの ownership、fresh reference、サイト/Chrome 失敗条件をなお検証する。

## 6. A/B 分離のライフサイクル受入れ

少なくとも次のシナリオを同じ versioned fixture/driver 契約で実行し、機密値のない結果を保存する。

| シナリオ | 合格条件 |
| --- | --- |
| A→B の順で起動 | A/B が別 generation/connection/profile に入り、両方が READY になる |
| B→A の順で起動 | 起動順に依存せず、各 broker が自分の binding だけを受け付ける |
| A ready timeout | A は mutation を0件 dispatch、B は READY/SERVING を継続 |
| A Host/Extension/Chrome 停止 | A の送信済み mutation は不確定、B の status/tabs/mutation は継続 |
| A crash→resume | A は旧 response を受け付けず、新 generation で再 pairing してから READY。古い snapshot は無効 |
| late response | old connection/generation の response は破棄され、B の pending/result/audit に現れない |
| storage 操作 | 同一 origin の cookie/localStorage/入力が A/B で交差しない |

## 7. 実装前に凍結する値

実装開始前に、次の値を ADR/protocol schema とテストで凍結する。

- 状態名、許可 transition、各 deadline、各 timeout と backoff
- ready signal の wire schema、発行者、probe の安全性
- identity tuple の形式・寿命・秘密性と lease renewal/rotation
- connection fence の生成規則、pending request の閉じ方、late response の扱い
- read-only retry の唯一の条件と上限。mutation no-retry の例外なし
- state/claim/descriptor/socket/audit file の配置・owner・mode・atomic write・stale 回収判定
- state/error/audit schema の version、client への safe projection
