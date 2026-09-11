# Gate 4 isolation acceptance test 実機試験結果

実施日時: 2026-09-11〜2026-09-12（JST）

対象は専用PoC Chrome A/B、各instance専用profile、pairing harness、session socket、Extension 0.0.5、同一loopback originのリポジトリ内fixtureである。この記録には実際のURL、port、title、tab ID、loader ID、backend DOM node ID、PID、session ID、browser/profile instance ID、generation、lease、nonce、marker値、入力textその他のruntime実値を保存しない。

## 目的と判定基準

[Gate 4実行計画](./gate-4-plan.md)に従い、同じoriginをA/Bの異なるprofileで開いたときのcookie/localStorage分離、A限定の層別停止からの復旧、同一profile再起動後の保存状態、old connection fence、private audit JSONLを確認した。停止対象以外のBを継続させ、cross-routing、Host終了、禁止内容の監査記録がないことを合格条件とした。

## 実施結果

### G4-1: 同一origin storageとnear-concurrent操作

- A/Bそれぞれに同一loopback originのfixtureを開き、異なる非機密markerをcookieとlocalStorageへ保存した。
- A/Bのnear-concurrentな`navigate`/`snapshot`で、各snapshotのcookie/localStorage/displayが対応profileのmarkerだけを示し、matchがtrueとなることを確認した。相互markerの混入はなかった。
- markerなしURLへ遷移した後も両profileの保存状態が残った。
- 保存後にA/Bへ異なるsuffixのnear-concurrent `type`を実行し、続けてnear-concurrentにSaveの`click`を実行した。各snapshotで対応するcookie/localStorage/displayのmatchがtrueのまま、相互suffixの混入がないことを確認した。`type`成功応答は入力textをechoしなかった。

### G4-2: A限定の停止と復旧

| Aで停止した層 | Bの実結果 | Aの実結果 |
| --- | --- | --- |
| Extension worker fault | 並行したping 2回が成功 | 一度のworker reload後、bounded wait内に復旧し`ACTIVE`/ping成功 |
| Native Host transport | 並行したping 2回が成功 | 自動resumeで`ACTIVE`/ping成功 |
| session harness | 並行したping 2回が成功 | quit/restart後、新generationでstale bindingの自動修復とpairingを経て`ACTIVE`、`browser_status`成功 |
| Aの管理Chrome process | 停止中もpingが継続成功 | 同じprofileで再起動後、自動`ACTIVE`/ping/`browser_status`成功 |

Extension 0.0.5はA/Bへロード済みだった。Aの管理reloadは成功し、Bの管理コマンドは再起動後に固定failureを表示したが、B processは稼働して`ACTIVE`/ping成功を維持した。その後の実worker faultで0.0.5のworker再起動・復旧経路を確認した。実機結果の判定にはraw errorやruntime値を用いていない。

各停止では、Aだけを対象にし、Bのprofile・socket・phase・pending requestへ影響がないことを確認した。Native Host切断、harness再起動、Chrome再起動後にcross-routingやHost終了は観測しなかった。

### G4-3: 同一profile再起動後の永続状態

Aを同じprofileでstop/startした後、AがmarkerなしURLへ遷移してもA自身のcookie/localStorage/displayのmatchがtrueとなり、Bの保存状態と混ざらないことを確認した。再起動中もBのpingとsnapshotは継続し、Bの表示値はB自身の状態だけだった。

### G4-4: old connection fence

実機のNative Messaging transportを安全に保持・再利用する手段がないため、旧transportを悪意あるlate response用に保持して再送する試験は実施していない。これは計画に定めた未実施境界である。

一方、自動state/socket/Host testでは、旧connection・遅延response・旧generationをfenceし、別instanceへfallbackしないことを確認した。実機のNative Host切断・自動rebindではconnectionのrotateと旧経路の拒否が働き、Bは継続した。Gate 4ではこの自動testを実機のadversarial injectionの代替証拠として採用する。

### G4-5: private audit JSONL

- A/Bのaudit fileはinstance/generationごとに分離され、regular file、0600、所有UID、nlink 1だった。
- 各eventは許可された8キーだけを持ち、禁止されたlease、nonce、host connection、URL、title、text、cookie、localStorage、raw error、path、PID等は含まなかった。
- 修正前の初回`browser_status`では、各fileにissuedだけが残りcompletionがなかった。原因はpending completion側のrequest ID欠落であり、`852d016`で修正した。
- 修正後の最終verificationではAが26行（13 request pair）、Bが22行（11 request pair）で、全requestがissued→successの順だった。両方のsampleに`browser_status`、`tabs_list`、`navigate`、`snapshot`、`type`、`click`が含まれ、outcomeはissued/successだけだった。

### Fixtureの停止経路

fixtureは同一loopback originに限定し、markerを保存するページ、boundチェック、HTML escaping、no-store/security headers、任意filesystem非提供を自動testで確認した。`npm run gate4-fixture -- --port 0`のPTY Ctrl-Cではnpm wrapperがexit 1を返すことがあるが、serverは停止した。直接の`node scripts/gate4-fixture.mjs --port 0`は実機Ctrl-Cでexit 0となり、自動SIGINT/SIGTERM testでもlistener閉鎖と停止後の接続拒否を確認した。

## 自動test

root独立実行の全suiteは197/197成功した。audit schema/permissions/serialized write/属性変更、A/B socket分離、late response fence、各停止・再bind、fixture CLI cleanupを含む。実機の旧transport adversarial injectionを自動testが置き換える境界は上記G4-4に記載した。

## 判定と制約

**Gate 4合格。** 同一origin上でもA/Bのprofile storageと操作結果は相互非混在であり、A限定の各層停止中もBは継続し、Aは指定経路で復旧した。同一profileのChrome再起動後も保存状態が保持され、audit JSONLはprivate・instance/generation分離・固定schemaを満たした。

実機での旧Native Messaging transport再利用によるadversarial late response試験は未実施であり、旧transportを保持するための新たな危険な運用経路は追加しない。screenshotはGate 3計画上の任意未実装機能であり、Gate 4判定には含めない。試験後はA/B harnessを正常終了し、専用Chromeも停止してcleanup完了を確認した。runtimeのPIDやpathなどの実値は記録しない。
