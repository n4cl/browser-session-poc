# G5-6 決定的acceptance driver（PoC/test-only）

`scripts/gate5-acceptance-driver.mjs` は、Codexモデルのtool引数生成を使わずに、既存のMCP stdio serverからNative Messaging、Extension、実Chromeまでを検証するPoC/test-only driverである。本番コードや通常のbrowser-control APIへ流用してはならない。

## 実行単位

1回のdriver processは、1つのMCP server processと1つの`instance-id`だけを所有する。A/Bは同一fixture originを指定した2つのdriver processを並列起動する。driverはChromeを起動・停止せず、既存launcherが管理する専用Chromeだけを使う。

共有fixtureを別途起動した場合の例（値は実行環境のものへ置き換える）：

```sh
node scripts/gate5-acceptance-driver.mjs \
  --instance-id <instance-a> \
  --fixture-origin http://127.0.0.1:<port> \
  --marker <marker-a> \
  --other-marker <marker-b> \
  --suffix <suffix-a>
```

A/Bは`--instance-id`、`--marker`、`--suffix`を分け、`--fixture-origin`だけ共有する。driver自身にfixtureを所有させる単独確認では`--start-fixture`を使える。その場合はdriver終了時にfixture childもbounded cleanupする。

## 固定protocolと操作順

driverはnewline-delimited JSON-RPCで、`initialize`、`notifications/initialized`、`tools/list`を順に送る。tool catalogは次の6個と完全一致しなければ停止する。

`browser_status`、`tabs_list`、`navigate`、`snapshot`、`click`、`type`

browser操作は次の順で行う。

1. `browser_status {}`
2. `tabs_list {}`で専用profile内のtabを1つ選択
3. fixture originへmarker query付きで`navigate`（1回だけ）
4. read-onlyの`snapshot`をbounded polling（snapshotだけ再試行可能）
5. fresh snapshotのMarker inputから`tab_id`、`loader_id`、`backend_dom_node_id`を取得し、`type`（1回だけ）
6. fresh snapshotからSave marker buttonを再取得し、`click`（1回だけ）
7. final `snapshot`（read-only polling可能）

`navigate`、`type`、`click`はtimeout、transport close、`outcome_unknown`を含めて自動retryしない。各IDは整数または文字列の既存schema型を維持し、snapshotで取得した値以外を合成しない。

## 出力とcleanup

stdoutはsanitizedなsummary JSON 1行だけで、stderrは固定diagnostic codeだけである。marker本文、URL、title、tab/loader/backend node ID、PID、session/runtime path、type text、raw errorは出力・保存しない。summaryにはtool count、snapshot attempt count、tool catalog、fixture h1、cookie/localStorage match、own marker、other marker absent、correlationのbooleanだけを含める。

driverはMCP childのstdinを閉じ、boundedに終了を待ち、必要時だけSIGTERM/SIGKILLを使う。`--start-fixture`で所有したfixture childも同じbounded cleanupを行う。Chrome、既存runtime、user/project configはdriverのcleanup対象外であり、別の管理手順に委ねる。

このdriverのunit/integration testはJSON-RPC framing、catalog exactness、型保持、snapshot由来target、mutation no-retry、sanitized summaryを検証する。実Chromeを使う試験は別の明示的な実行単位で行う。
