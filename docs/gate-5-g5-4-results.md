# Gate 5 G5-4 lifecycle/crash/restart結果

実施日: 2026-09-12（日本時間）。MCP server processの終了、transport failure、強制終了後の同一instance再起動をsynthetic Native HostとUnix socketで検証した。実Chrome、Codex/Claude Codeの実clientは未実施である。

## 判定

**G5-4はsocket/process-level自動検証で合格。Gate 5全体は未合格・未完了。**

## 検証範囲

追加した[`tests/mcp-lifecycle.test.mjs`](../tests/mcp-lifecycle.test.mjs)は、実MCP server child process、実PairingSocketServer、synthetic Native Hostを組み合わせる。

- `runMcpServer`のtransport failure注入で、固定`mcp_transport_failed`だけをstderrへ出し、MCP handleとharnessを一度ずつcloseすることを確認した。raw transport detailやruntime pathは出力しない。
- active socket切断中のpending readは`transport_closed`、pending `navigate`は`outcome_unknown`となり、どちらも自動再送しないことを確認した。
- AのMCP childを`SIGKILL`で強制終了し、Aの旧pending requestを再送せず、同時にpendingだったBのreadが成功し、Bのprocess/socketは継続することを確認した。
- Aを同じinstanceで再起動するとgenerationとsession socketが更新され、新しいHost connectionだけが新MCP requestを完了することを確認した。旧connection/旧requestは新serverへ配送されない。
- A/Bのaudit fileがinstanceごとに分かれ、Aのgeneration 1/2、Bのgeneration 1が独立して残ることを確認した。auditのexact schema・private属性はG5-3と既存logger testsで検証する。

正常なstdin EOF、SIGINT/SIGTERM、二重close、startup rollbackは既存の[`tests/mcp-server-entry.test.mjs`](../tests/mcp-server-entry.test.mjs)で確認済みである。SIGKILLではprocess自身の`finally`によるcleanupを主張しない。次回起動時にprocess identity、claim ownership、descriptor、socket probeを検証し、安全に回収できる場合だけstale resourcesを回収する。live owner、active socket、変更済みprivate fileなど回収不能条件は既存のclaim/harness testsどおりfail-closedとする。

stdoutを意図的に壊すchild testは追加していない。MCP SDKのmalformed/oversized input境界はG5-0で確認済みであり、G5-4ではserver側のtransport error/closeを固定診断へ変換する経路を検証した。

## 結果

```text
node --test tests/mcp-lifecycle.test.mjs \
  tests/pairing-state-machine.test.mjs \
  tests/mcp-server-entry.test.mjs \
  tests/pairing-claim.test.mjs \
  tests/pairing-harness.test.mjs  -> 49 pass / 0 fail
npm test                         -> 223 pass / 0 fail
git diff --check                 -> pass
```

変更したproduction logicは、socket transport切断時のbrowser command cancellationだけである。timeout cancellationは従来どおりread=`timeout`、mutation=`outcome_unknown`を維持し、transport cancellationだけread=`transport_closed`へ分離した。G5-5の実client互換性、G5-6の実機acceptanceは未実施である。
