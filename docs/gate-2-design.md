# Gate 2 pairing設計

## 判断

Gate 2は、instance専用のNative Messaging manifestとwrapperを起点に、session専用Unix socketへ決定的に接続する方式を採用する。

```text
browser instance / profile A
  → manifest A → wrapper A → descriptor A → Unix socket A

browser instance / profile B
  → manifest B → wrapper B → descriptor B → Unix socket B
```

Native Messaging Host名、active tab、最後に接続したExtension、接続順をroutingに使用しない。wrapperは自分のinstance directoryに固定されたdescriptorだけを読み、他instanceを探索しない。

## pairing page方式を採用しない理由

pairing pageへnonceを渡す方式は、Extensionへnonceを明示的に渡せる一方、Hostがどのsession socketへ接続するかを決める機構を別に必要とする。また、通常版Chromeではunpacked Extensionを手動で導入する必要があり、pageの表示・URL・Reload・失効を追加で管理することになる。

Gate 1で、profileごとのmanifestとwrapperからNative Hostが起動することを確認済みである。この既存の決定経路にdescriptorを接続先として加えれば、UIやtabに依存せずにHost→session socketを一意にできる。pairing pageやpopupは、将来人による再pairing承認が必要になった場合だけ検討する。

## 脅威モデル

対象は次である。

- accidental cross-routing: AのHost / Extension / commandがBのsession socketへ到達すること
- stale connection: 旧generation、旧lease、旧Host connectionからのcommandを受け入れること
- 再接続や起動順の違いで、暗黙に別instanceへfallbackすること

同一macOSユーザーとして実行され、runtime directoryやdescriptorを読める悪意あるprocessからの完全な防御は非目標である。descriptorを0600、親directoryを0700にし、nonce・lease ID・page contentを通常ログへ出さないが、これは権限分離と誤操作防止のための保護であって完全な敵対者対策ではない。

## lifecycle

Chromeを起動する前に、session harnessが次を完了させる。

1. `browser_instance_id`に対応するprofile metadataを読み、なければ`profile_instance_id`を生成して0600で永続化する。
2. sessionごとのUnix socketをlistenする。socketは0700の短いruntime directory内に作る。
3. 現在のgeneration、lease、初回用nonceを含むdescriptorを0600で原子的に発行する。
4. instance専用Native Host manifest / wrapperが存在することを確認する。
5. 専用`--user-data-dir`でChromeを起動する。

wrapperはinstance directoryに固定されたactive descriptorのパスを使用してHostを起動する。Extensionからdescriptor path、socket path、instance IDを受け取って接続先を選ぶことはしない。

descriptorとsocketはlease終了、期限切れ、pairing失敗時に失効させる。更新時はgenerationを増やし、新しいlease IDとnonceを発行する。

## IDとdescriptor schema

identity tupleは全commandとresponseで使用する。

```text
session_id
browser_instance_id
profile_instance_id
generation
lease_id
request_id
```

| ID | 生成主体 | 寿命 |
| --- | --- | --- |
| `session_id` | session harness | session終了まで。session中に再bindしない。 |
| `browser_instance_id` | launcherの検証済み引数 | persistent profileへの割当中。 |
| `profile_instance_id` | launcher | profile初期化時にランダム生成し、profile metadataへ永続化。profileを作り直すまで不変。 |
| `generation` | session harness | leaseを新規発行・失効・回収するたびに単調増加。 |
| `lease_id` | session harness | generationごとにランダム生成。resume時は同一generation内で保持する。 |
| `pairing_nonce` | session harness | 初回Host登録で一度だけ消費。成功・失敗を問わず再利用しない。 |
| `request_id` | command発行側 | requestごとにランダム生成。responseは同じ値を返す。 |
| `host_connection_id` | Native Host | Native port / Unix socket接続ごとにランダム生成。再接続ごとに変わる。 |

descriptorの最小schemaは次とする。未知のfieldを含むdescriptorや、schema version不一致はfail-closedで拒否する。

```json
{
  "schema_version": 1,
  "session_id": "opaque-session-id",
  "browser_instance_id": "validated-instance-id",
  "profile_instance_id": "persistent-random-id",
  "generation": 1,
  "lease_id": "random-lease-id",
  "pairing_nonce": "one-time-random-nonce",
  "socket_path": "absolute-unix-socket-path",
  "issued_at": "timestamp",
  "expires_at": "timestamp"
}
```

macOSのUnix socket path長には上限がある。socket名は短いランダム値とし、socketをbindする前にプラットフォーム上のbyte長を検証する。上限超過時に別directoryや別instanceへfallbackしない。

## protocolと状態遷移

session harnessはleaseごとに次の状態を持つ。

```text
ABSENT
  → ISSUED
  → PAIRING
  → ACTIVE
  → REVOKED
```

| 遷移 | 条件 | 処理 |
| --- | --- | --- |
| `ABSENT → ISSUED` | socket listenとdescriptor発行成功 | generation、lease、nonceを確定する。 |
| `ISSUED → PAIRING` | Hostの`host_register`がtuple、期限、nonceで一致 | nonceを原子的に消費し、Host connectionを候補として記録する。 |
| `PAIRING → ACTIVE` | Extensionの`pair_ack`がtupleと`host_connection_id`で一致 | 候補connectionだけをactiveにする。 |
| `ACTIVE → ACTIVE` | Hostの`resume`が現generationとleaseで一致 | 新しい`host_connection_id`のack完了後だけ接続を切り替える。 |
| 任意 → `REVOKED` | 期限切れ、不一致、pairing失敗、lease回収 | socketを閉じdescriptorを失効する。再試行には新generationを発行する。 |

### 初回pairing

1. Extensionがinstance固有のNative Hostへ`hello`を送る。
2. HostはExtension originを検証し、descriptorを読んで`host_register`をsession socketへ送る。messageにはidentity tuple、`pairing_nonce`、`host_connection_id`を含める。
3. harnessはnonceを一度だけ消費し、`pair_challenge`に必要なtupleとconnection IDをHostへ返す。
4. HostはExtensionへ`pair_challenge`を送る。Extensionはtupleとconnection IDを保持し、同じ値の`pair_ack`を返す。
5. Hostがackをharnessへ転送する。harnessは一致時だけACTIVEにする。

nonceは初回登録のcapabilityであり、再送・並行Host・失敗後の再試行に使わない。pairing途中で失敗した場合はREVOKEDにし、次の試行では新generation・新lease・新nonceを発行する。

### resume

Extension ReloadやHost crash後、descriptorが有効なACTIVE leaseなら、新Hostは`resume`を送る。nonceは送らず、現generationと`lease_id`および新しい`host_connection_id`を照合する。harnessはExtensionの新しいackが完了するまで旧connectionを置換しない。旧connectionから遅れて届くmessageはconnection ID不一致として拒否する。

## 境界ごとの検証

| 境界 | 必須検証 |
| --- | --- |
| Extension → Host | Extension origin、protocol version、保持中のtuple、`host_connection_id`。 |
| Host → session socket | descriptorの0600・schema・期限、identity tuple、初回nonceまたはresume lease、connection ID。 |
| session socket → Host | active generation・lease・connection ID、request ID。 |
| Host → Extension | descriptor由来のtupleとExtensionがackしたconnection ID。 |
| command response | requestと同一のidentity tupleおよびrequest ID。harnessは不一致responseを破棄する。 |

Host、harness、Extensionはいずれもtuple不一致を補正・変換しない。明示的なinstance以外を探索せず、socket未接続、descriptor不在、期限切れ、権限不正、origin不一致、nonce replay、lease不一致では失敗を返して自身のconnectionだけを閉じる。所有者不明のprocessをkillしない。

## 失敗とクラッシュ

- Host crash: Aのsession socketだけがconnectionを失う。Bのdescriptor、socket、leaseには触れない。Aは同一ACTIVE leaseの`resume`、または新generation発行で復旧する。
- Extension Reload: 新しいNative Host connectionに新しい`host_connection_id`を発行し、ack後にだけ切替える。
- socket server crash: descriptorを有効なbindingとして扱わない。server再起動後は旧leaseをREVOKEDにして新generationを発行する。
- descriptor read / parse失敗: Hostはstderrへ診断を出し、stdoutにはprotocol以外を出さずに終了する。
- mutation command timeout: Gate 2ではmutationを実装しない。将来も自動retryではなく`outcome_unknown`にする。

## Gate 2 acceptance test

自動testでは実Chromeを必要としないtransport abstractionを用意し、少なくとも次を検証する。

1. A/Bを起動順不同で発行しても、A→socket A、B→socket Bになる。
2. Bの発行・再接続・失敗がAのACTIVE stateを変更しない。
3. 同じnonceの二重登録、期限切れnonce、descriptor改変を拒否する。
4. 旧generation、旧lease、旧`host_connection_id`、異なるinstance ID / profile ID / session IDを全境界で拒否する。
5. Host crash後の同generation resumeは、ack完了後だけ新connectionをactiveにする。
6. responseのtupleまたはrequest IDを変えた場合、harnessが破棄する。
7. socket path上限超過、権限不正、socket不在に対してfallbackせず失敗する。

実機確認ではA/Bの専用profileに手動でunpacked Extensionを導入し、identity付き`ping`とExtension Reload後のresumeだけを確認する。

## 段階的実装

1. profile metadata、descriptor schema、0600 / 0700、socket path長検証を追加する。
2. sessionごとのUnix socket serverと`ISSUED` / `PAIRING` / `ACTIVE` / `REVOKED` state machineを追加する。
3. wrapperから固定descriptorを渡し、Hostが`host_register`する最小transportを追加する。
4. Extensionに`pair_challenge` / `pair_ack`とtuple保持を追加する。
5. `resume`と旧connection fencingを追加する。
6. A/B acceptance testと実機の`ping`確認を行う。

Gate 2はidentity付き`ping`のみを対象とする。MCP adapter、browser tool、`chrome.debugger`、tab操作は実装しない。
