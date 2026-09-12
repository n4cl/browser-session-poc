# Gate 5 G5-0 SDK / stdio smoke結果

実施日: 2026-09-12（日本時間）。G5-0のprotocol-level検証だけを実施した。Codex/Claude Codeの設定変更、公式clientの実起動、pairing harness、Chrome操作は実施していない。

## 判定

**G5-0は合格。G5-1以降とGate 5全体は未実装・未判定。**

追加した直接依存は次の1つだけである。

```text
@modelcontextprotocol/server 2.0.0
```

`package-lock.json`はlockfileVersion 3で生成した。解決されたproduction treeは次のとおりで、zodはSDKのtransitive依存である。

```text
@modelcontextprotocol/server@2.0.0
├── @modelcontextprotocol/core@2.0.0
└── zod@4.6.2
```

server/coreはNode.js `>=20`、package metadataのlicenseはMITで、install scriptは定義されていない。zod 4.6.2もMITでinstall scriptは定義されていない。公式repositoryのlicense transitionは採用後も別途確認が必要である。

`npm audit --omit=dev`は、production dependencies 3 packageについて既知脆弱性0件（info/low/moderate/high/criticalすべて0）だった。

## fixtureと確認範囲

[`scripts/mcp-smoke-server.mjs`](../scripts/mcp-smoke-server.mjs)にSDK単体の隔離fixtureを追加した。`serveStdio`へ`legacy: "serve"`を指定し、2025-era openingを同じfactoryの単一server instanceへ固定する。`StdioServerTransport`のinput bufferは64 KiBに設定し、stdoutにはSDKが生成するnewline-delimited JSON-RPCだけを書き込む。fixtureのtoolは引数が空objectだけの`health`一つで、固定`ok`だけを返す。browser instance、pairing、Chrome、auditへは接続しない。

input schemaはSDK公開APIの`StandardSchemaWithJSON`をfixture内で最小実装した。これにより、healthの`tools/list` schemaを`type: object`、空`properties`、`additionalProperties: false`として公開し、zodを直接依存へ追加せずにunknown fieldを拒否できることを確認した。

[`tests/mcp-sdk-smoke.test.mjs`](../tests/mcp-sdk-smoke.test.mjs)で次を確認した。

- 2025-03-26 initialize、serverInfo、initialized通知、tools/list、health tools/call
- unknown toolと余分な引数の固定エラー。入力の識別文字列をerrorへechoしない
- 通常応答がJSONとしてparseでき、stdoutにbanner/debug/raw errorを出さない
- stdin EOFによるexit 0と、SIGTERMによるboundedなexit 0
- 64 KiBを超える受信messageをSDK transportが診断し、fixtureが固定診断後にstdin EOFでexit 0すること

oversized入力ではSDK transportが`maxBufferSize`超過を検出するが、transport errorだけで親processを強制終了する契約ではない。そのためfixtureは固定`mcp_smoke_error`をstderrへ1行だけ出し、stdin EOFで自身をcloseする。テストは終了イベントlistenerを入力前に登録し、killを成功条件に使わない。

## 実行結果

```text
node --test tests/mcp-sdk-smoke.test.mjs  -> 4 pass / 0 fail
npm audit --omit=dev                     -> 0 vulnerabilities
```

G5-0の成功はCodex/Claude Codeのclient互換性を意味しない。G5-1以降で、各clientの2025-era initialize、tools/list/tools/call、process終了・再起動、stdout/stderr境界を公式CLI設定で別々に確認する。
