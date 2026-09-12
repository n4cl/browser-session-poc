# Gate 5 G5-2 six tools adapter結果

実施日: 2026-09-12（日本時間）。G5-2のMCP adapterとprotocol-level自動検証を実施した。Codex/Claude Codeの実client、管理Chrome、実A/B acceptanceは未実施である。

## 判定

**G5-2はadapter-levelで合格。Gate 5全体は未合格・未完了。**

## 実装

[`scripts/mcp-browser-adapter.mjs`](../scripts/mcp-browser-adapter.mjs)を追加し、`scripts/mcp-server.mjs`のhealth toolを次の6 toolへ置き換えた。

- `browser_status`
- `tabs_list`
- `navigate`
- `snapshot`
- `click`
- `type`

adapterは`startPairingHarness`が所有する`harness.server`の既存request APIを一回だけ呼ぶ薄い変換層であり、coreのidentity、request ID、timeout、audit、late response fence、mutation `outcome_unknown`を再実装しない。MCP request IDとは別にcore request IDを生成し、各結果からsession、lease、nonce、host connection、profile path、raw errorを除外する。tabs resultはURL/titleを返さず、typeのtextもresult/errorへ返さない。

入力schemaは6 toolごとにexact fieldsと追加フィールド拒否を設定し、既存のnavigate/click/type validatorを再利用した。成功結果はbounded `structuredContent`と固定`ok` content、失敗結果はcoreの固定error codeだけを含む`isError` resultとする。64 KiB境界をMCP result全体でも確認し、自動retryは行わない。

## 自動検証

[`tests/mcp-browser-adapter.test.mjs`](../tests/mcp-browser-adapter.test.mjs)で次を確認した。

- tools/listが6 toolだけを返し、empty/exact input schemaとmutation/read-only annotationを確認
- 6 toolが対応core methodを各1回だけ呼び、MCP request IDとcore request IDを分離
- malformed/unknown fields、fixed error、`outcome_unknown`、oversized result、no-retryを確認
- tabsのURL/title、type text、raw Chrome errorがMCP result/errorへ出ないことを確認
- child entry pointのA/B継続性と、既存全suiteを再確認

```text
node --test tests/mcp-browser-adapter.test.mjs tests/mcp-server-entry.test.mjs  -> 13 pass / 0 fail
npm test                                                                      -> 214 pass / 0 fail
git diff --check                                                               -> pass
```

G5-3でauditの実MCP結果相関、G5-4でcrash/restart、G5-5でCodex/Claude実client、G5-6で実A/B browser acceptanceを検証する。
