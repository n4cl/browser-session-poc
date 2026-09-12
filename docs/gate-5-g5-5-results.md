# Gate 5 G5-5 Codex実client互換性結果

実施日: 2026-09-13（日本時間）。Codex CLI 0.154.0を使い、project configを変更しないdirect `-c` one-shot overrideで、ローカルstdio MCP serverの実client接続を検証した。認証情報、user configの内容、絶対path、temp path、secret、rawログはこの文書へ記録しない。

## 判定

**G5-5はCodex側partial pass。Gate 5全体は未合格・未完了。**

- Codex: direct `-c` override、stdio server認識、6 tool catalog、`browser_status{}` の実call 1回、未paired時の固定`transport_closed`、exit 0、最終`PASS`を確認した。
- Claude Code: 未導入・未実施。
- 実Chrome: 未実施。

## CLI修復

先行確認では、破損したCodex CLI Caskの0.104.0から、公式Homebrew経由で0.154.0へ修復した。修復後の`codex mcp --help`と`codex exec --help`はいずれもexit 0だった。

## project-scoped config方式の失敗

一時project内の`.codex/config.toml`にstdio serverを登録する方式を2回試行した。いずれもCodex `exec`自体はexit 0だったが、MCP tool-call event、6 tool catalog、`transport_closed`結果を確認できず、最終応答は固定形式のFAILだった。

- project layerが実行時にロードされなかったと判断した。
- runtimeのclaim、descriptor、socket、audit、server processのspawnを示す観測はなかった。
- `tools seen 1/6`はprompt中のtool名を単純カウントした値で、実際のMCP callは0回だった。
- 一時project、runtime、設定ファイルは試験後に削除した。

## direct `-c` one-shot override

project configは作成せず、CLIの単回overrideだけで次の設定を渡した。

- stdio command: 管理対象Node executable
- args: `scripts/mcp-server.mjs --instance-id poc-g5-codex`
- `cwd`: repo root
- `required = true`
- `startup_timeout_sec = 10`
- `tool_timeout_sec = 10`
- `BROWSER_POC_RUNTIME_ROOT`: 隔離した一時runtime

モデル/APIを使わない`mcp list`で、`poc_browser`が`enabled`として認識されたことを確認した。direct overrideにより、user configとproject configを変更せずにstdio serverを登録できた。

## Codex実client結果

Codex `exec --ignore-user-config --ephemeral --json --sandbox read-only`へ同じoverride群を渡し、次を確認した。

| 確認項目 | 結果 |
| --- | --- |
| tool catalog | `browser_status`、`tabs_list`、`navigate`、`snapshot`、`click`、`type`の6 toolをモデルが確認 |
| 実MCP call | `browser_status`を`{}`で1回だけ実行 |
| 未paired結果 | 固定`transport_closed` |
| process結果 | exit 0 |
| モデル最終応答 | `PASS` |

MCP server起動後にはinstance generation、Native Messaging host/profile metadata、audit fileが一時runtimeへ生成された。未pairedのためaudit recordは0件で、socketとclaimは空だった。実行後にruntime全体を削除し、repoはcleanであることを確認した。

### usage集計

機密でない集計値だけを記録する。

```text
input_tokens              46,180
cached_input_tokens       30,208
output_tokens                 192
reasoning_output_tokens      101
```

production code、test code、repoのuser/project configは変更していない。commitはこの結果記録と計画更新だけを対象とし、pushは行わない。

## 参照

- [OpenAI Docs: Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)（CLIの`-c`/`--config`、dot notation、TOML one-shot override）
- [OpenAI Docs: Codex MCP](https://developers.openai.com/codex/mcp)（stdio serverのcommand/args/env/cwd/required）
