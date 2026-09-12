# Gate 5 G5-1 process entry point結果

実施日: 2026-09-12（日本時間）。G5-1のprocess/lifecycle検証だけを実施した。6 browser tool、Codex/Claude Codeの実client設定、実Chrome操作は実施していない。

## 判定

**G5-1は合格（lifecycle-level）。Gate 5全体は未合格・未完了。**

## 実装

[`scripts/mcp-server.mjs`](../scripts/mcp-server.mjs)を追加した。entry pointは次のstrict形式だけを受ける。

```text
node scripts/mcp-server.mjs --instance-id <instance-id>
```

instance IDは既存`validateInstanceId`、runtime pathは既存`resolvePairingPaths`を通し、`BROWSER_POC_RUNTIME_ROOT`またはrepo内の`.runtime`を使う。process起動後は明示instanceの`startPairingHarness`を一度だけ作成し、別instance、pairing-session CLI、reload command、ping、shared daemonへfallbackしない。G5-1で公開するMCP toolは固定結果を返す`health`だけで、browser commandやChromeへ接続しない。

startup、transport、shutdownの診断は`mcp_invalid_arguments`、`mcp_startup_failed`、`mcp_transport_failed`、`mcp_shutdown_failed`の固定行だけである。runtime path、instance secret、raw exception、Chrome/CDP errorはstdout/stderrへ出さない。stdoutはSDKが生成するJSON-RPCだけを使う。

closeは一度だけ実行し、`handle.close()`後にharnessをcloseする。stdin EOF、SIGINT、SIGTERM、transport errorのcleanup経路を共有し、startup途中のharness failureは既存harness rollbackへ渡す。

## 自動検証

[`tests/mcp-server-entry.test.mjs`](../tests/mcp-server-entry.test.mjs)で次を確認した。

- strictな`--instance-id`、余分な引数、unsafe ID、nulを含むruntime rootの拒否
- child processのsynthetic legacy 2025 initialize、initialized、tools/list、health call
- stdin EOFによるexit 0、SIGINT/SIGTERMによるexit 0、二重closeの無害性
- harness setup failure時の固定startup error、claim rollback、stdout空、raw/path非出力
- EOF/signal後のdescriptor、claim、socket cleanupとaudit file close確認
- A/Bを別child processで起動し、A終了後もBのhealth callが継続すること

```text
node --test tests/mcp-server-entry.test.mjs  -> 6 pass / 0 fail
npm test                                    -> 207 pass / 0 fail
git diff --check                            -> pass
```

G5-1のhealthはprocess継続性だけを確認するfixtureであり、browser操作の成功やCodex/Claudeのstdio互換性を意味しない。G5-2で既存coreへ6 browser toolを接続する前に、MCP request schema、fixed errors、audit相関を別作業単位で追加する。
