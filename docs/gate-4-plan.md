# Gate 4 isolation acceptance test 実行計画

この文書はGate 4の具体的な実行計画であり、この作業単位では実装・実機試験を行わない。Gate 3で合格した`browser_status`、`tabs_list`、`navigate`、`snapshot`、`click`、`type`を前提に、A/Bのprofile・connection・lifecycle分離を確認する。

## 1. 目的と前提

A/Bはそれぞれ専用のuser-data-dir、profile metadata、descriptor、session socket、Native Host、Extension bindingを持つ。検証用ページは同じlocalhost originから提供し、A/Bの異なるprofileに同じページを開く。同一originであることにより、origin差ではなくprofile境界によるcookie/localStorage分離を検証できる。

実行前に次を満たすことを確認する。

- A/Bの新しいleaseでpairingし、両方が`ACTIVE`である。
- A/Bでfresh snapshotを取得し、操作対象のtab・loader・backend DOM nodeを各instance内で選ぶ。
- localhostの試験ページは、入力結果をcookieとlocalStorageへ保存し、そのprofileの保存値だけをsnapshotへ表示する。markerの値は試験画面で照合するが、ログ・audit・この記録には保存しない。
- 24時間leaseは長時間の停止・復旧を一回の作業単位で確認する場合だけ明示する。通常の短い試験は既定leaseを使用する。

## 2. 作業単位と合格条件

### G4-1: cookie/localStorageとnear-concurrent操作の分離

1. A/Bの同一originページへ、A/Bそれぞれ異なる入力を`type`する。
2. ページJavaScriptが入力に対応するcookie/localStorage markerを保存し、snapshotで自profileのmarkerだけを表示することを確認する。
3. AのsnapshotにBのmarkerがなく、BのsnapshotにAのmarkerがないことを確認する。cookie/localStorageの値そのものは記録しない。
4. A/Bへ`type`、`snapshot`、必要な`navigate`をnear-concurrentに発行し、各responseのtab・loader・request相関と状態変化が自instanceだけに残ることを確認する。

合格条件は、A/Bの入力・cookie・localStorage・snapshot表示が相互に混ざらず、near-concurrent操作でcross-routing、Host終了、identity mismatchが発生しないことである。

### G4-2: A限定の層別停止と復旧

同じ初期状態から、Aだけを次の順で停止する。各段階でBの`ping`とread-only browser commandを継続し、Bが成功することを確認する。Aは段階ごとに指定された復旧を確認し、次の段階へ進む前にA/Bのphaseを再確認する。

| 順序 | Aで停止する層 | 実行・復旧 | Bに求める結果 | Aに求める結果 |
| --- | --- | --- | --- | --- |
| 1 | session harness | Aの対話sessionを`quit`し、Aだけ新しいsession harnessを起動する。これは将来のMCP process lifecycleの代替試験とする。 | `ping`・read commandを継続成功 | 旧接続は受理せず、新session/new generationでpairingして`ACTIVE`へ復旧 |
| 2 | Native Host transport | Aのharnessで既存の`disconnect-active-host`を一度だけ実行する。 | `ping`・read commandを継続成功 | 同じbindingのresumeで`ACTIVE`へ復旧。自動retryでmutationを再送しない |
| 3 | Extension service worker | paired sessionから固定引数なしのExtension専用fault-injection commandを一度だけ送る。`chrome.runtime.reload()`を呼び、応答不能を前提にする。 | `ping`・read commandを継続成功 | service worker再起動後に自動rebind/resumeで`ACTIVE`へ復旧 |
| 4 | AのChrome process | Aを所有identity照合済みの`chrome stop`で停止し、同じprofileで`chrome start`する。 | `ping`・read commandを継続成功 | cookie/localStorageを保持したまま再pairingし、`ACTIVE`へ復旧 |

各段階で停止対象以外のA/B資源をkill・reload・resetしない。Chrome停止前に対象profile、owner UID、process identityを照合し、不一致なら停止せず中断する。復旧に失敗した場合は次の層へ進まず、runtimeを回収して原因を記録する。

Extension fault injectionの候補は次のとおり比較し、paired sessionからの固定内部commandを採用する。

| 候補 | 判断 |
| --- | --- |
| 通常の`browser` APIへreloadを露出 | 不採用。通常操作と障害注入の境界が曖昧で、意図しないreloadを許す |
| Options URLやUI操作でreload | 不採用。session identityと結び付かず、既存tab・service workerの状態にも依存する |
| paired sessionから固定commandで`chrome.runtime.reload()` | 推奨。active identity、A限定のsocket、固定引数なしで実行でき、応答不能・no retryを明示できる。production browser APIへは公開しない |

### G4-3: 同一profile再起動後の永続状態

G4-1でA/Bのmarkerを作成した後、Aだけを同じprofileでChrome stop/startする。Aが復旧したあと、Aのcookie/localStorage markerが残り、Bのmarkerと混ざらないことを確認する。Bのprofileを作り直したり、binding resetを行ったりして結果を補正しない。

合格条件は、Aの保存状態が同じprofile restart後も残り、Bの状態と相互非混在であること、さらにA/Bのphaseが`ACTIVE`へ戻ることである。

### G4-4: old connection fence

自動integration testで、次を先に合格させる。

- 旧`host_connection_id`、旧generation、旧lease、旧sessionのrequest/responseをactive connectionへ通さない。
- timeout後のlate responseと、切断後の旧socketからのresponseを破棄し、別instanceへfallbackしない。
- Aの旧connectionをfenceしてもBのpending request・phase・socketに影響しない。

実機では可能なfault-injection境界でAをdisconnect/rebindしたあと、保持していた旧connection相当の送信を一度だけ試し、Aが拒否され、Bが継続することを確認する。旧connectionの秘密値をログや試験記録へ出さない。実機で旧transportを安全に再利用できない場合は、同じ条件を自動transport testの合格証拠とし、実機項目を未実施として明記する。

### G4-5: private audit JSONL（追加予定）

監査ログはGate 4の実装作業で追加する。推奨方式は、`browser_instance_id`と`generation`ごとに専用の0600 regular fileを持つserialized append writerである。親directoryは0700、runtime rootはGit管理外とし、instance/generationを跨いで同じファイルへ書かない。

1イベントの許可schemaは次だけとする。

```json
{
  "session_id": "...",
  "browser_instance_id": "...",
  "profile_instance_id": "...",
  "generation": 1,
  "request_id": "...",
  "command": "type",
  "outcome": "success",
  "timestamp": "..."
}
```

`outcome`は`success`、固定error codeによる`failure`、`outcome_unknown`を区別する。`lease_id`、`nonce`、`host_connection_id`、URL、title、text、cookie、localStorage値、raw error、path、PIDは記録しない。入力textのdigestやlengthも、入力内容の推測に使えるためこのPoCでは記録しない。

writerはopen済みfdを保持してイベントを直列化し、flush/errorを呼出し側へ返す。作成時にlstatでsymlinkでないregular file、所有UID、0600、nlink=1を確認し、途中で属性が変わった場合はfail-closedで書込みを停止する。pathを追跡して別instanceへfallbackせず、close時までfdを変更しない。書込み失敗はcommand結果を成功へ変換せず、audit failure自体は秘密を含まない固定診断として扱う。実装前に既存runtimeのatomic/private file abstractionと統合可能かを確認する。

### G4-6: 実行方式と証跡

| 検証対象 | 自動test | 実Chrome |
| --- | --- | --- |
| A/B identity、socket分離、late response、old fence | 必須 | 可能な範囲のdisconnect/rebindのみ |
| cookie/localStorage marker非混在 | fixtureとprotocol test | 必須、同一originページで確認 |
| near-concurrent type/snapshot/navigate | 必須 | 必須 |
| session harness quit/restart | lifecycle test | A限定の実機確認 |
| Native Host transport切断 | socket/Host integration test | `disconnect-active-host`でA限定確認 |
| Extension reload fault | fixed-command unit/integration test | A限定の応答不能・自動rebind確認 |
| Chrome stop/startと永続状態 | launcher/metadata test | A限定の実機確認 |
| audit schema/private file | exact schema、permission、属性変更test | runtime fileを非機密属性だけ確認 |

## 3. 実行順、停止、復旧

1. localhost試験ページ、A/Bの新lease、private runtime rootを準備する。ページ内容・marker値をログへ出さない。
2. G4-1を完了し、A/Bのsnapshotとphaseを確認する。
3. G4-2を表の順に一段ずつ実行する。各段階でBの継続とAの復旧を記録し、失敗時はその段階で停止する。
4. G4-3のA同一profile restartを実行し、保存状態とphaseを再確認する。
5. G4-4の自動testを先に実行し、実機fault injectionは対象を完全照合してから一度だけ行う。
6. audit実装後にG4-5を実行し、内容、mode、regular file、symlink/hardlink拒否、serialized write、closeを検証する。
7. localhost serverを停止し、sessionを`quit`し、A/Bの専用Chromeを所有確認後に停止する。descriptor、socket、claim、temporary fileを既存cleanupで回収し、別instanceのruntimeは触らない。

復旧不能な場合は、まず対象instanceだけをREVOKEDにし、旧descriptor/socketを再利用しない。新generation・新leaseでpairingをやり直す。原因究明中はcookie、localStorage、text、URL、title、identity secret、raw exceptionを採取せず、固定stage/errorと非機密なpass/failだけを残す。

## 4. Gate 4合格条件と中止条件

Gate 4は次をすべて満たした場合だけ合格とする。

- A/Bのcookie、localStorage、tab、snapshot、入力結果が同一origin上でも相互非混在である。
- Aの各層停止中もBのpingとread-only操作が継続する。
- Aは各停止から指定されたresume/restartで復旧し、旧connectionのcommandを受け入れない。
- 同一profileのChrome restart後にAの保存状態が残り、Bへ影響しない。
- 自動testと実機testの境界、未実施項目、固定error、outcome_unknownを記録できる。
- audit JSONLが許可schema、private file属性、instance/generation分離、非機密制約を満たす。

次の場合はその段階で停止し、Gate 4を不合格として方式を再検討する。

- Aの操作・停止・復旧がBのprofile、socket、phase、pending requestへ影響した。
- cookie/localStorage markerまたはsnapshotが相互に見えた。
- old connection、late response、timeout後のmutationが受理された。
- owner・profile・descriptorの照合なしにChromeやruntime fileを操作する必要が生じた。
- auditへ禁止項目が混入する、またはprivate file属性をfail-closedに維持できない。

実行記録は既存のGate結果docsと同じく、実施日時、環境、手順、期待/実結果、失敗条件、security上の懸念、判定だけを残し、runtimeのURL、title、tab、loader、backend node、PID、session、generation、lease、nonce、cookie、localStorage、textなどの実値は保存しない。
