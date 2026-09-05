# Browser Session Isolation PoC 実装計画

## 1. 目的

次の対応を、通常版Google ChromeとChrome Extension / Native Messagingで実現できるか確認する。

```text
agent session A → browser instance A → persistent profile A
agent session B → browser instance B → persistent profile B
```

このPoCの成果は製品コードではなく、実現可否、失敗条件、protocol上の不変条件、再現可能なacceptance testである。成立した場合もPoCコードをそのまま本実装へ育てず、得られた仕様とテストを基に作り直す。

## 2. 最重要の検証項目

1. 異なる`--user-data-dir`でChrome A/Bを同時起動できる。
2. session A/Bを、対応するChrome A/Bへ決定的にpairingできる。
3. cookie、localStorage、tab、入力操作がA/B間で混ざらない。
4. AのMCP、Native Host、Extension、Chromeのいずれかを停止してもBへ影響しない。
5. 旧generation、誤ったbrowser instance ID、期限切れleaseからのcommandを拒否できる。

## 3. PoCの非目標

- 本番品質のUI、installer、自動更新
- Chrome Web Storeまたはenterprise policyによる配布
- Windows/Linux対応
- 全CDP domainと全browser toolの実装
- bot検知の完全回避保証
- shared daemon、複数host対応、remote browser対応
- 長期運用向けの暗号鍵管理、監査基盤、telemetry

## 4. 実装原則

- 最初はshared daemonを置かず、sessionごとにMCP processとlocal IPCを分離する。
- browser instanceごとに専用の絶対`user_data_dir`を割り当て、active中は共有しない。
- 暗黙のactive tabや「最後に接続したExtension」をroutingに使わない。
- request/responseの両方でidentity tupleを照合する。
- click/type/navigate等の変更操作は、timeoutを理由に自動retryしない。
- portやprofileの競合時に、所有者不明のprocessをkillしない。
- pairing token、cookie、page contentを通常ログへ出さない。

identity tuple:

```text
session_id
browser_instance_id
profile_instance_id
generation
lease_id
request_id
```

## 5. 技術選択

### Phase 0〜2

- macOS上の通常版Google Chrome
- Manifest V3 Extension
- `chrome.runtime.connectNative()`
- `chrome.tabs`、`chrome.scripting`、必要最小限の`chrome.debugger`
- Node.js ESM
- Node.js標準の`node:test`
- Unix domain socketと所有者だけが読める短寿命descriptor

外部npm dependencyはまだ追加しない。MCPを接続する段階で、公式MCP SDKを使用する案と最小JSON-RPC実装を比較し、ライセンス・保守性・API互換性を確認してから決める。

### pairing設計

Gate 2は、instance専用profile→manifest→wrapper→descriptor→session専用Unix socketの決定経路を採用する。pairing pageへnonceを渡す旧案は採用しない。state machine、nonce一回利用、resume、脅威モデル、acceptance testは[Gate 2 pairing設計](./gate-2-design.md)を参照する。

## 6. Gate方式の実装順序

後続Gateは直前Gateの合格後にだけ進める。

### Gate 0: Chrome process/profile分離

実装:

- 一時領域にA/Bのuser data directoryを作るlauncher
- Chrome A/Bの起動、PID/start time記録、所有instanceだけの停止
- dry-runと引数検証
- 非GUI testではprocess identityのparserと照合条件だけを検証する。実Chromeの起動・`ps`照合はmacOSの実行権限がある環境でのみ行う。

合格条件:

- A/Bを同時に起動できる。
- `chrome://version`相当の情報から異なるprofile pathを確認できる。
- Aを停止してもBが残る。
- 同じuser data directoryの二重割当を起動前に拒否する。
- `stop`後に終了を確認するまでclaimを保持し、停止途中の同一profile再起動を拒否する。

### Gate 1: 1 ChromeとNative Messagingの疎通

進捗: **合格**（2026-09-04）。実機結果は[Gate 1実機試験結果](./gate-1-results.md)を参照。

実装:

- 固定IDを持つ最小Extension
- Native Messaging Host manifest生成・導入・削除script
- Native Messagingのlength-prefixed JSON codec
- `hello`、`hello_ack`、`ack`だけの最小protocol

Gate 1では固定IDのunpacked Extensionに`nativeMessaging`だけを要求し、`hello`→`hello_ack`→`ack`を最小protocolとする。Native Messagingのmessage size上限はChrome→Hostが64 MiB、Host→Chromeが1 MiBであり、codec testで方向を区別する。

合格条件:

- ExtensionからHost processが起動する。
- HostがExtension originを検証する。
- disconnect後に再接続できる。
- stdoutへprotocol以外を出力しない。

### Gate 2: A/Bの決定的pairing

進捗: **単一instance経路を実機通過**（2026-09-05）。Gate全体の合格ではない。詳細は[Gate 2単一instance実機試験結果](./gate-2-results.md)を参照。

実装:

- nonce descriptorとsession専用Unix socket
- profileごとの`profile_instance_id`
- generation/lease fencing
- identity tuple付きrequest/response

合格条件:

- 起動順を入れ替えてもA→A、B→Bになる。
- B起動時にAの接続を奪わない。
- nonce再利用、旧generation、別instance IDを拒否する。
- AのHost crash/reconnect中もBが継続する。

このGateに失敗した場合はbrowser toolを実装せず、方式を再検討する。

### Gate 3: 最小browser tool

実装順:

1. `browser_status`
2. `tabs_list`
3. `navigate`
4. `snapshot`
5. `click`
6. `type`
7. 必要な場合だけ`screenshot`

合格条件:

- commandは明示した所有tabだけで実行される。
- A/Bが同時にnavigate/click/typeしても結果が混ざらない。
- response identityがrequestと異なる場合は結果を破棄する。
- mutation timeoutは`outcome_unknown`となり、自動再送されない。

### Gate 4: isolation acceptance test

自動または半自動で次を再現する。

1. A/Bで異なるcookieとlocalStorage markerを設定する。
2. 相互のmarkerが見えないことを確認する。
3. A/Bが同時に異なるページを操作する。
4. AのMCP、Host、Extension、Chromeを順に停止してBの継続を確認する。
5. Aを同じprofileで再起動し、状態が残ることを確認する。
6. Aの旧connectionからのcommandが拒否されることを確認する。
7. audit log上で全操作をsession/browser/requestへ対応付けられることを確認する。

### Gate 5: Codex / Claude Code接続

Gate 4まではrouting自体をCLI test harnessで検証する。合格後にstdio MCP adapterを追加し、CodexとClaude Codeから同じcoreを呼ぶ。

合格条件:

- Codex session A/BでGate 4の主要項目を再現できる。
- Claude Code session A/Bでも同じ結果になる。
- clientの終了・resume時のMCP process lifecycleを記録できる。

## 7. 想定するPoC配置

```text
extension/       Chrome Extension
native-host/     Native Messaging codecとHost
core/            session、pairing、lease、routing
scripts/         launcher、host manifest管理、手動spike補助
tests/           unit / integration / acceptance
docs/            計画、protocol、検証結果、廃棄判断
.runtime/        socket、descriptor、一時profile（Git管理外）
```

ディレクトリは必要になったGateでだけ作る。先に空の構造を作らない。

## 8. 検証記録

各Gateで次を記録する。

- 実行日時、macOS/Chrome/Node.jsバージョン
- 実行手順
- 期待結果と実結果
- 再現可能な失敗
- security上の懸念
- 合格、条件付き合格、不合格
- 次Gateへ持ち越す課題

profile path、nonce、cookie、認証済みURL等は記録へ含めない。

## 9. commit方針

- branch: `spike/browser-session-isolation`
- Gate単位でlocal commitする。
- `main`へmergeしない。
- remoteへpushしない。pushが必要になった時点で確認する。
- research cloneとresearch notesは引き続きGit管理外とする。
- 成立後は`main`から本実装branchを作り、PoCのproduction codeはcopyしない。
- acceptance testの仕様とprotocol decisionだけを再実装する。

## 10. 中止・再設計条件

次のいずれかに該当したら、その場で機能追加を止める。

- 複数profileのNative Messaging接続を決定的に区別できない。
- Aの起動・終了がBのprocessまたはconnectionへ影響する。
- fencing前のcommandがExtensionまで到達する。
- 対象サイトで`chrome.debugger`方式が成立しない。
- Extension/Native Hostの社内配布が組織policy上許可されない。

止めた時点で、失敗条件と代替案を記録して方式を選び直す。
