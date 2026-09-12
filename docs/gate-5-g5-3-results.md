# Gate 5 G5-3 audit統合結果

実施日: 2026-09-12（日本時間）。実MCP tools/callから既存`PairingSocketServer`と既存audit loggerへ接続する統合検証を追加した。Codex/Claude Codeの実client、管理Chrome、G5-4のcrash/restartは未実施である。

## 判定

**G5-3はprotocol-level自動検証で合格。Gate 5全体は未合格・未完了。**

## 検証範囲

新しい[`tests/mcp-audit-integration.test.mjs`](../tests/mcp-audit-integration.test.mjs)は、production audit logicを複製せず、実際のMCP stdio adapter、`PairingSocketServer`、Unix socketのactive Host、audit loggerを組み合わせる。

- `issued` auditの完了後だけsocket dispatchし、completion auditの完了後だけMCP result/errorを返す順序を検証した。
- issued gateとcompletion gateを保持した同期的な応答、およびsocket write中のreentrant responseを検証した。
- issued audit failureでは固定`audit_unavailable`を返し、Hostへのdispatchがないことを検証した。
- completion audit failureではread (`browser_status`、`tabs_list`、`snapshot`)を`audit_unavailable`、mutation (`navigate`、`click`、`type`)を`outcome_unknown`へ写像することを検証した。
- MCP result/errorにはURL、title、cookie/localStorage値、type本文、lease、nonce、host connection、raw error/path/PID、MCP request IDを含めず、audit eventはexact 8 keysだけであることを確認した。
- 実audit fileをA/Bの別fixtureへ作成し、generation/browser instance相関、file mode 0600・regular・nlink 1、instance directory mode 0700を検証した。

symlink、hardlink、foreign owner、mode変更、既存fileの拒否は既存の[`tests/pairing-audit-log.test.mjs`](../tests/pairing-audit-log.test.mjs)で引き続きfail-closedを確認しており、G5-3ではそのproduction loggerを実MCP経路へ接続した。

## 結果

```text
node --test tests/mcp-audit-integration.test.mjs \
  tests/mcp-browser-adapter.test.mjs \
  tests/pairing-audit-log.test.mjs \
  tests/pairing-audit-integration.test.mjs  -> 22 pass / 0 fail
npm test                                      -> 219 pass / 0 fail
git diff --check                              -> pass
```

本作業単位ではproduction audit実装、G5-4 process crash/restart、実Chrome、Codex/Claude設定を変更・実施していない。
