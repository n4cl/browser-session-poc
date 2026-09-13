# Gate 5 G5-6 deterministic driver実機acceptance結果

実施日: 2026-09-13（日本時間）。既存の専用Chrome A/Bと共有fixtureを対象に、決定的PoC/test-only driverをA/B各1 processでnear-concurrentに1回だけ実行した。driver、MCP server、instanceの対応は各process内で1対1に固定した。

実行契約は[決定的driver仕様](./gate-5-deterministic-driver.md)に固定している。

## 結果

**G5-6 deterministic end-to-endは未成立。Gate 5全体は未合格・未完了。**

- A/Bとも最初の`browser_status`で固定`transport_closed`となり停止した。
- A/B各runのtool countは`browser_status=1`、`tabs_list=0`、`navigate=0`、`snapshot=0`、`type=0`、`click=0`だった。
- mutationは0回、audit eventは0件だった。
- driver child、MCP child、descriptor、claim、socketはA/Bともcleanup成功。Git作業ツリーもcleanだった。
- 共有fixtureは親管理のためdriverからは停止していないが、結果取得後に親operatorが明示停止済みである。
- URL、marker、title、tab/loader/node ID、PID、session/runtime path、raw errorは出力・記録していない。

## 前段Codex実client status-only checkpoint

deterministic driverの前段で、A/Bを別Codex process・別MCP serverとして実行し、各1回の`browser_status` actual MCP callを確認した。このcheckpointはCodex real client → MCP → 実Chromeのstatus-only partial passであり、tabs、mutation、G5-6、Gate 5全体の合格を意味しない。

- A初回はactual MCP tool call 0で固定`TOOL_UNAVAILABLE`。同方式2回目はactual call開始/完了`1/1`で、実call結果の`extension_connected=true`かつ`chrome_tabs_available=true`を確認し、PASSとした。
- Bはactual call開始/完了`1/1`で、実call結果の同じ2 booleanがtrueだった。ただしモデル最終判定の表現は`UNAVAILABLE`であり、実call結果とモデル判定は分離して記録する。
- このcheckpointでは`tabs_list`、navigate、snapshot、type、click、その他mutationの成立を主張しない。

## 境界要因と未実装要件

今回の観測だけでChrome、Extension、Native Hostのいずれかを単独原因とは断定しない。有力な境界要因は、MCP serverのtool受付開始とExtension/Native Host ACTIVE成立の間に明示ready同期がなく、driverがACTIVE確認前に接続依存toolを送信したことである。

製品要件としては、browser tool受付前のready signal/wait、bounded timeout、disconnect handling、mutation送信とreadiness確認の分離が必要になる。ただし、browser_status pollingやready notification/waitの実装はこのPoC作業単位では追加しない。今回のdriverは現状の契約を固定したPoC/test-only artifactとして凍結し、追加拡張や製品コードへの流用は行わない。

## 合格範囲の整理

- Codex実client stdio/status: G5-5でCodex側partial pass。
- protocol/audit/lifecycle: G5-0〜G5-4のsynthetic/protocol-level検証はpass。
- 実Chromeの6 browser toolとA/B profile isolation: Gate 4でpass。
- G5-6 deterministic driverによる実Chrome end-to-end: 未成立。
- Claude Code: アカウントのない別端末での検証待ち。導入・実行していない。

Gate 5全体の合格判定は行わない。PoCコードを本実装へ流用せず、既存の[PoC方針](./poc-plan.md)どおり、検証結果と契約を基に製品実装を作り直す。
