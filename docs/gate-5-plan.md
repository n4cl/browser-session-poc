# Gate 5 Codex / Claude Code MCP接続 実行計画

この文書はGate 5の実装計画である。G5-0（公式SDKのstdio smoke）、G5-1（process lifecycle）、G5-2（six tools adapter）、G5-3（audit統合のprotocol-level自動検証）、G5-4（lifecycle/crash/restartのsocket/process-level自動検証）は完了した。G5-5はCodex側partial passまで進んだが、Claude Code実機接続、実Chrome、Gate 5全体の合格判定は未完了である。Gate 4で合格したcore、pairing、A/B分離、browser command、auditの不変条件をMCPのstdio境界へ持ち込むための作業単位と合格条件を定める。G5-0の固定依存・テスト・監査結果は[G5-0結果](./gate-5-g5-0-results.md)を参照する。

調査基準日は2026-09-12（日本時間）、G5-5実施・本計画更新日は2026-09-13（日本時間）である。Context7はこの環境で利用できないため、MCP仕様・公式TypeScript SDK・OpenAI Codex・Anthropic Claude Codeの公式一次資料を参照した。公式資料のURLと確認事項は末尾にまとめる。

## 1. 現状と設計制約

リポジトリはNode.js ESMのprivate PoCで、`package.json`に`engines`指定はなく、テストはNode標準の`node:test`で実行する。現在の実行環境はNode.js 26系で、G5-0で`@modelcontextprotocol/server@2.0.0`だけを直接依存へ追加した（他の直接依存は追加しない）。Gate 5では既存のcore APIをMCP adapterから呼び、browser操作のroutingやidentity検証を別実装しない。

現在のcoreの呼び出し口は次のとおりである。

| MCP tool | coreの呼び出し口 | 種別 | 既定timeout |
| --- | --- | --- | ---: |
| `browser_status` | `PairingSocketServer.requestBrowserStatus` | read-only | 1,000 ms |
| `tabs_list` | `PairingSocketServer.requestTabsList` | read-only | 1,000 ms |
| `navigate` | `requestNavigate` | mutation | 1,000 ms |
| `snapshot` | `requestSnapshot` | read-only | 5,000 ms |
| `click` | `requestClick` | mutation | 5,000 ms |
| `type` | `requestType` | mutation | 5,000 ms |

`requestExtensionReload`は障害注入専用で、通常のbrowser toolには公開しない。`ping`もMCP toolやbrowser commandにせず、接続状態の内部確認に限定する。MCP adapterが扱える操作は上の6 toolだけとする。

次の制約はMCP導入後も変えない。

- MCP server processの起動時にbrowser instanceを1つだけ明示する。起動後のtool引数にinstanceの切替を許さない。
- A/Bは別process、別profile、別session socket、別audit fileで動かす。shared daemon、暗黙の「最後の接続」、別instanceへのfallback、MCP process内のrebindは実装しない。
- adapterは`startPairingHarness({ runtimeRoot, instanceId })`を一度だけ作り、そのserverへcore requestを転送する。対話CLIのline parserを再利用しない。
- stdoutはMCP/JSON-RPC messageだけ、stderrは固定された診断だけとする。起動バナー、URL、identity、lease、nonce、raw exception、Chrome/CDP errorをstdoutにもstderrにも出さない。
- `navigate`、`click`、`type`はmutationであり、timeout、transport close、送信後の不確定な失敗を`outcome_unknown`として自動retryしない。入力textはrequestにだけ存在し、response、error、audit、通常ログへechoしない。
- snapshotの構造化上限、tab/document/nodeの相関、request IDの一意性、64 KiB response上限、auditのexact 8 fieldsは既存coreに委ねる。adapterで上限を緩めない。

## 2. MCP SDKと自前stdio adapterの比較

### 2.1 公式TypeScript SDK

調査時点の公式SDK v2は、単一の`@modelcontextprotocol/sdk`ではなく、`@modelcontextprotocol/core`、`@modelcontextprotocol/client`、`@modelcontextprotocol/server`などに分割されている。npmで確認したserver packageの公開安定版は`@modelcontextprotocol/server` **2.0.0**で、Node.js `>=20`、MIT metadata、runtime dependenciesはcoreとzodの2つである。公式SDKはTier 1実装として扱われ、v2のrelease lineは2026-07-27にGAとなっている。旧v1 monolithは1.30.0系でbug/security fixが続いているが、Gate 5の新規採用候補にはしない。

v2は2025-11-25系と2026-07-28系を扱う。2026-07-28系または両方を受けるstdio serverは`serveStdio(() => buildServer())`を使う設計で、旧2025系だけなら`StdioServerTransport`を直接利用できる。SDKのversion negotiation `auto`はstdioで互換性確認のため使い捨ての兄弟processを先に起動し得るため、spawn-per-invocationのCLIでは余分な起動・transcript・timeout要因になる。Gate 5では互換性を実測してから明示的に接続方式を固定し、autoに依存しない。

長所は、initialize/initialized、capability、tools/list、tools/call、JSON-RPCのtransport framing、error、closeを仕様に沿って実装できること、公式conformanceに寄せられること、将来のprotocol更新を追いやすいことである。短所は、version negotiationとv1/v2 APIの選択、zodを含む依存、SDKのrelease/ライセンス移行を継続確認する必要があること、デフォルトのエラー・loggingがこのPoCのsecret-free境界と一致するとは限らないことである。

ライセンスは注意する。npm公開packageのmetadataはMITだが、公式TypeScript SDK repositoryは新規コードについてMITからApache-2.0への移行を説明している。採用時はpackage metadata、LICENSE、含まれる依存のlicenseをlockfileと一緒にレビューし、PoCの配布先で許可されることを確認する。ここではその確認と依存追加を行わない。

### 2.2 最小の自前JSON-RPC 2.0 stdio adapter

自前案は依存ゼロで、必要なMCP subset（initialize、tools/list、tools/call、shutdown、通知、error）と出力schemaを完全に固定できる。stdoutの汚染を防ぎ、coreの固定errorをMCP errorへ変換する境界も狭くできる。一方で、MCPのprotocol negotiation、JSON-RPC request ID、framing、通知、cancel、capability、最大message、process終了、将来のversion差分を自分で保守し、公式conformanceを毎回通す責任が生じる。MCPを名乗るだけの独自JSON-RPCとして実装することはしない。

自前案の運用リスクは、Malformed inputのparse上限、stdoutへの一行ログ混入、unknown methodの扱い、half-closed stdin、late response、キャンセルとmutation結果の不確定性をSDKなしで漏れなく扱う必要がある点である。依存を減らしてもsecurity boundaryの実装量は減らない。

### 2.3 推奨決定

G5-0では公式SDK v2.0.0の固定版を追加し、Node 26の独立stdio smokeで2025-era initialize、initialized、tools/list、health tools/call、unknown/malformed request、stdout境界、EOF、SIGTERM、64 KiB input boundを確認した。標準の`StandardSchemaWithJSON`形をfixture内で実装できたため、zodは直接依存へ追加していない。G5-2でhealthを6 tool adapterへ置き換えた。Codex/Claudeの実client接続は未実施であり、G5-5で確認する。`@modelcontextprotocol/sdk` v1を新規追加したり、`@latest`を実行時に解決したりしない。

G5-0で確認したSDKが現在のNodeとlegacy 2025 wire smokeに適合しない、license reviewを通せない、stdout/close/error境界を安全に固定できない場合は、G5-1へ進まず親レビューで自前adapterを再評価する。その場合もMCP仕様の2025系を明示し、公式transportとconformance試験を実装してから進める。Codex/Claudeの実client互換性はまだ判定していない。

## 3. adapter境界とtool契約

### 3.1 起動とinstance固定

G5-1のserver entry pointは`node scripts/mcp-server.mjs --instance-id <instance-id>`である。`--instance-id`は一度だけ受け、空白、重複引数、未知のoption、余分な引数、解決不能なinstanceを拒否する。instance IDをtool parameterから受けない。G5-2ではlifecycle確認用の`health`を置き換え、6 browser toolだけを公開する。

起動成功後は次の順序を守る。

1. stdoutへ何も出さず、固定形式の引数と安全なruntime rootを検証する。
2. 明示instanceのprofile/descriptorを既存のclaim・ownership検証で確認する。
3. `startPairingHarness`を1回だけ呼び、現在generationのsession serverとaudit loggerを確立する。
4. MCP initializeを完了してからtools/listとtools/callを受け付ける。
5. stdin EOF、SIGTERM、transport closeのどれかで、未処理toolを固定失敗にsettleし、harness/serverとaudit loggerを順にcloseしてboundedに終了する。

serverは別instanceへ接続しない。process restartは新しいharness/generationとして扱い、前のprocessのpending mutationを再送しない。起動失敗は固定コードだけをstderrに出し、MCP initializeが完了していなければprotocol messageを捏造しない。

### 3.2 tool schemaと結果

最初の`tools/list`には次の6つだけを返す。schemaは追加の自由フィールドを許さず、IDsは既存browser protocolの厳格型へ変換する。

| tool | input | result/error | MCP annotation案 |
| --- | --- | --- | --- |
| `browser_status` | `{}` | coreの固定status result、または固定error | `readOnlyHint: true` |
| `tabs_list` | `{}` | coreのbounded tabs result、または固定error | `readOnlyHint: true` |
| `navigate` | `{tab_id, url}` | tab相関済みsuccess、または固定error/`outcome_unknown` | `readOnlyHint: false` |
| `snapshot` | `{tab_id}` | bounded AX snapshot、または固定error | `readOnlyHint: true` |
| `click` | `{tab_id, loader_id, backend_dom_node_id}` | `{accepted:true,...相関情報}`、または固定error/`outcome_unknown` | `readOnlyHint: false` |
| `type` | `{tab_id, loader_id, backend_dom_node_id, text}` | `{accepted:true,...相関情報}`、または固定error/`outcome_unknown` | `readOnlyHint: false` |

`type.text`はrequestに必要だが、MCP result、error data、stderr、auditへ一切コピーしない。`text`の長さ・空文字・UnicodeやJSON parsingは既存`validateTypeTarget`と同じ4,096 UTF-16 code units制約で検証する。`loader_id`、`backend_dom_node_id`、`tab_id`は既存のsafe integer/空白なし条件で検証する。navigate URLも既存のhttp/https、制御文字、credential、8,192文字制限を再利用する。

MCPのrequest IDとcoreのrequest IDの対応は内部で保持するが、auditには既存coreが生成する安全なrequest IDだけを渡し、MCP request ID、tool arguments、URL、title、textをauditへ記録しない。MCP clientへ返すresultに必要なtab/loader相関は既存protocolの許可された値だけとし、session、lease、nonce、host connection、profile path、raw Chrome errorを返さない。MCP errorの`code`/固定メッセージはbrowser error whitelistから構成し、raw `Error.message`/`stack`を`data`へ入れない。

### 3.3 auditとmutation境界

adapterはaudit writerを複製せず、`startPairingHarness`が作るgeneration専用auditへcore requestを通す。browser commandではissued auditが完了してからdispatchし、completion auditが完了してからMCP result/errorを返す。audit failure時は未dispatchを`audit_unavailable`で拒否し、read-onlyの完了audit失敗も固定`audit_unavailable`、navigate/click/typeの完了audit失敗はmutation結果不確定として`outcome_unknown`にする。server close中のissued待ち、timeout、late response、old connection responseは既存state machineのfenceを通す。

MCP clientがtimeout後に同じtools/callを再送してもadapterは自動retryしない。特にclick/type/navigateは再送による二重mutationを許さず、client側へ`outcome_unknown`と再試行不可の説明を固定errorとして返す。SDKの自動retry設定が存在する場合は無効化し、process restartも同じ扱いにする。

## 4. stdio protocolとprocess lifecycle

MCP stdio transportではclientがserver subprocessを起動し、stdin/stdoutをUTF-8の改行区切りJSON-RPC messageに使う。stdoutには有効なprotocol message以外を書かず、stderrは任意の診断用である。serverはmessage内に改行を含めず、1 messageの上限を明示する。Nodeのuncaught exceptionやdebug logがstdoutへ出ないよう、entry pointのconsole出力を監査する。

initializeが最初のrequestで、version/capabilityを交渉し、clientのinitialized後にtools/list/tools/callを受ける。protocol versionの選択は採用したSDK APIに応じて固定し、Codex/Claudeの実装が受ける版を自動推測で本番運用しない。stdioのshutdownではstdinを閉じ、pending requestをboundedにsettleし、harness/auditをcloseしてからprocessを終了する。通常のSIGTERMではgraceful closeを試み、期限を過ぎた場合は親clientがSIGKILLする。SIGKILLやcrash後にmutationを再送しない。

MCP server processの一生とpairing sessionの一生を同じものとして扱う。clientが接続を切ったときはharness.closeを一度だけ行い、old server/socket/descriptorを別clientへ再利用しない。再起動時は新generationでpairingする。serverから外部のshared broker、daemon、別instanceへ接続しない。

## 5. Codex / Claude Codeの設定互換性

両clientともlocal stdio serverを「clientがcommandをspawnする」形で設定できる。実装では`npx`や起動時のinstallを使わず、管理下のNode executableとrepo内のentry pointを絶対pathで指定する。A/Bを別名・別instanceで登録し、同じMCP processを共有しない。次は計画上の形であり、runtime値・ユーザー設定へそのままコミットしない。

Codexのproject/user configは次の形にする。

```toml
[mcp_servers.browser-session-a]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/scripts/mcp-server.mjs", "--instance-id", "poc-a"]
cwd = "/absolute/path/to/browser-session-poc"
startup_timeout_sec = 10
tool_timeout_sec = 30
```

Codex CLIでは公式の`codex mcp add <name> -- <command> [args...]`と`codex mcp list`を使い、A/Bを別server nameとして確認する。既定tool timeoutはGate 5の5秒snapshot/30秒protocol上限と混同せず、server/coreのmutation timeoutを外側のclient timeoutへ合わせる。

Claude Codeのproject `.mcp.json`は次の形にする。

```json
{
  "mcpServers": {
    "browser-session-a": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/scripts/mcp-server.mjs", "--instance-id", "poc-a"]
    }
  }
}
```

Claude Codeでは公式の`claude mcp add`または`.mcp.json`を使う。project scopeのserverは承認を要するため、承認内容と起動commandが一致することを確認する。Codex/Claudeの設定へsecret、nonce、runtime path、実機のURL/IDを保存しない。

## 6. 実装作業単位

Gate 5は次の順で実装する。各単位は失敗時に次へ進まず、既存Gate 4の自動testと`npm test`を先に通す。

### G5-0: protocol・SDK・license smoke

進捗: **完了（2026-09-12、protocol-levelのみ）**。結果は[G5-0結果](./gate-5-g5-0-results.md)を参照する。公式clientの実起動・設定変更・実Chrome操作はこの作業単位に含めない。

- 公式SDK v2.0.0の固定版を一時branchで評価し、Node 26でserverを起動する。
- synthetic legacy 2025 stdio clientによる接続を確認した。modern/bothは未実施で、必要なら`serveStdio`の別testとして扱う。Codex/Claudeの実client互換性はG5-5で確認し、version auto probeは使わず選択理由を記録する。
- initialize、initialized、tools/list、最小tools/call、unknown tool、malformed params、stdin EOF、SIGTERMを確認する。
- stdoutがJSON-RPCだけで、stderrに固定診断だけが出ることを確認する。
- package license、transitive dependency、lockfile、Node engineをレビューし、採用を親レビューで確定する。

### G5-1: process entry pointと厳格startup

進捗: **完了（2026-09-12、lifecycle-levelのみ）**。結果は[G5-1結果](./gate-5-g5-1-results.md)を参照する。G5-2のadapter-level実装は完了したが、Codex/Claude実client、実Chromeは未実施である。

- `--instance-id`のstrict parser、safe runtime root、startup failureの固定errorを追加する。
- 1 process=1 instance=1 harness/serverをテストし、Aを止めてもBが継続することを自動確認する。
- stdin EOF、SIGTERM、二重close、harness setup rollback、audit close、descriptor/claim cleanupをboundedに検証する。
- 通常のpairing-session CLI、`reload-extension-worker`、ping、shared daemonへの入口をadapterから分離する。

### G5-2: six tools adapter

進捗: **adapter-level実装・自動検証完了（2026-09-12）**。結果は[G5-2結果](./gate-5-g5-2-results.md)を参照する。Codex/Claude実client、実Chrome、G5-3以降のaudit/lifecycle検証は未実施である。

- `tools/list`の6名、input schema、annotation、固定result/errorをexact比較する。
- 各toolが対応するcore request一回だけを呼ぶこと、MCP request IDとcore request IDを取り違えないことをtestする。
- response 64 KiB、snapshot node/depth/text bound、URL/text/ID parser、unknown fields、unknown tool、notification、duplicate/late responseを検証する。
- click/type/navigateのmutation failure、timeout、transport close、server closeを`outcome_unknown`へ固定し、再送しない。

### G5-3: audit統合

進捗: **protocol-level統合検証完了（2026-09-12）**。結果は[G5-3結果](./gate-5-g5-3-results.md)を参照する。実Chrome、Codex/Claude実client、G5-5以降は未実施である。

- issued→dispatch→completion→MCP result/errorの順序を、同期response/reentrant writeを含むtestで確認する。
- audit fileのexact 8 keys、A/B・generation分離、private permission、attribute change fail-closedを既存logger testへ接続する。
- `type`のtextと、URL/title/cookie/localStorage、lease/nonce/host connection、raw error/path/PIDがMCP output/stderr/auditのどこにも現れないことをnegative testする。
- audit preflight failureでdispatchしないこと、readのcompletion audit failureとmutationのcompletion audit failureの結果を分ける。

### G5-4: lifecycle/crash/restart

進捗: **socket/process-level自動検証完了（2026-09-12）**。結果は[G5-4結果](./gate-5-g5-4-results.md)を参照する。SIGKILL中のprocess自身のcleanupは主張せず、次回起動時のownership/socket probeによる安全なstale回収とfail-closed条件を検証した。実Chrome、Codex/Claude実clientは未実施である。

- server processを正常EOF、SIGTERM、強制終了、stdout破損相当のtransport failure/close、stdin closeで終了させ、orphaned socket/descriptor/Native Host claimを残さないことをtestする。
- crash中の未完了readは固定transport error、未完了mutationは`outcome_unknown`とし、再起動後に再送しない。
- restartは新generationでしかACTIVEにならず、old process/old connectionのresponseを新processへ配送しないことをtestする。
- A processだけを終了・再起動し、Bのpending request、socket、audit、phaseへ影響しないことを確認する。

### G5-5: Codex/Claude local stdio compatibility

進捗: **Codex側partial pass（2026-09-13）**。結果は[G5-5結果](./gate-5-g5-5-results.md)を参照する。G5-5全体は未完了であり、Claude Codeは未導入・未実施、実Chromeも未実施である。

- project-scoped `.codex/config.toml`方式は2回失敗した。project layer未ロードと判断し、server spawnを示す観測も得られなかった。
- Codex CLI 0.154.0では、project/user configを変更しないdirect `-c` one-shot overrideへ切り替えた。stdio serverを認識し、6 tool catalog、`browser_status{}` 1回、固定`transport_closed`、exit 0、`PASS`を確認した。
- 実行後のruntime、claim、descriptor、socket、audit、一時設定はcleanup済みで、repoはcleanである。production/test変更はない。

- 公式CLIでA/Bを別server名として登録し、`list`、initialize、tools/list、各toolの固定入力を実行する。
- project `.codex/config.toml`と`.mcp.json`は一時作業領域へ生成し、repoやauditへruntime値を残さない。
- client起動、approval、tool timeout、client終了、client再起動をCodex/Claudeそれぞれで確認する。client側の再送が発生したときのmutation安全性も記録する。
- real clientの機密ログを結果docsへコピーせず、合否・固定error・非機密な件数だけを記録する。

### G5-6: A/B実機acceptanceと結果記録

決定的なPoC/test-only driverを追加した。`scripts/gate5-acceptance-driver.mjs`はモデルのtool引数生成を介さず、1 process=1 MCP server=1 instanceを維持してJSON-RPCと6 toolを固定順序で実行する。read-only snapshotだけbounded retryを許し、navigate/type/clickは各1回でtimeout・`outcome_unknown`時に再送しない。A/Bは同一fixture originを共有する2 driver processとして並列起動できる。実Chromeでのdriver実行は別作業単位であり、本コミットでは未実施である。詳細は[決定的driver仕様](./gate-5-deterministic-driver.md)を参照する。

1. 同一originのGate 4 fixtureを起動し、A/BのMCP server processへ別instanceを渡す。
2. Codex A/BとClaude A/Bで`browser_status`、`tabs_list`、`navigate`、`snapshot`、`type`、`click`を順に実行する。`click`/`type`対象は各instanceのfresh snapshotから選ぶ。
3. A/Bのnear-concurrent操作でcookie/localStorage marker、snapshot、tab、loader、mutation結果が混ざらず、各responseが自requestへ相関することを確認する。marker、text、URL、title、runtime IDは記録しない。
4. AだけのMCP process crash/restartを行い、Bのping/read-only操作を継続する。Aは新generation/pairingへ復旧し、old responseを受け付けない。
5. AのNative Host transport、Extension worker、ChromeをGate 4と同じ停止順で層別停止し、B継続とA復旧を確認する。MCP adapter自身の再起動も別ケースにする。
6. auditをcloseし、A/Bのgeneration別fileがprivate属性とexact schemaを保つことを確認する。
7. fixture、MCP process、harness、Chromeを所有確認付きでcleanupし、orphan process、claim、descriptor、socket、temporary configを残さない。

## 7. 合格条件と停止条件

Gate 5は、次のすべてを自動testとCodex/Claude双方のA/B実機testで確認した場合だけ合格とする。

- MCP initialize/version/capability/tool schemaが選択した公式仕様に適合し、stdoutがprotocol以外を含まない。
- 起動時instanceの明示、A/B process・profile・socket・generation・auditの分離が維持される。
- 6 toolが同じcoreを呼び、identity/request/response/connection/target相関と既存boundsを弱めない。
- navigate/click/typeのtimeout・transport・client再送・process crashでmutationを自動retryせず、必要時に`outcome_unknown`を返す。
- issued auditがdispatchより前、completion auditがresultより前であり、禁止項目がMCP output/stderr/auditへ出ない。
- Codex/Claudeの起動、tool call、終了、再起動、A限定fault、B継続、cleanupが再現できる。

次のいずれかでその作業単位を停止し、Gate 5を不合格または保留にする。

- SDKのversion negotiationまたはCodex/Claudeのstdio互換性が曖昧なまま解消できない。
- stdoutへ一行でもbanner、debug、raw exception、secretが混入する。
- instanceをtool引数で切替できる、shared daemonへfallbackする、Aの停止がBへ影響する。
- auditのissued/completion順序、private属性、禁止フィールド、mutation no-retryを満たせない。
- client終了/crash後にharness、socket、claim、audit、Chrome processを安全に回収できない。
- 公式SDKのlicenseまたは依存のreviewを完了できない。

自前adapterへ切り替える場合は、上記の停止理由、採用するMCP protocol version、実装するsubset、公式conformance結果を先に記録し、SDKを半端に模倣する変更を混在させない。

## 8. 公式資料（2026-09-12確認）

- MCP stdio transport: [MCP Transports](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/transports.mdx)。client起動、newline-delimited JSON-RPC、stdout-only protocol、stderr diagnostics、bounded shutdownの前提に使う。
- MCP lifecycle: [MCP Lifecycle](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/basic/lifecycle.mdx)。initialize/initialized、version/capability、shutdownの前提に使う。
- 公式server package: [`@modelcontextprotocol/server` npm](https://www.npmjs.com/package/@modelcontextprotocol/server?activeTab=versions)。v2.0.0、Node engine、公開metadataを確認した。
- v2 release/migration: [TypeScript SDK v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)、[release line discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3268)。split packageとv1/v2の対応を確認した。
- stdio API: [TypeScript SDK v2 StdioServerTransport](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/stdio.html)、[2026-07-28 support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)。`serveStdio`とlegacy transport、version negotiationの注意点に使う。
- license: [TypeScript SDK LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)。npm metadataとrepository license transitionを採用判断の確認対象にする。
- Codex MCP設定: [OpenAI Codex MCP](https://developers.openai.com/codex/mcp/)、[Codex config reference](https://developers.openai.com/codex/config-reference/)。stdio command/args/cwdとtool timeoutを確認した。
- Claude Code MCP設定: [Claude Code MCP](https://code.claude.com/docs/en/mcp)。stdio server、`claude mcp add`、`.mcp.json`、scope/approvalを確認した。
