# Browser Session Isolation PoC 最終評価

評価基準日: 2026-09-15（JST）

この文書は、[元の実装計画](./poc-plan.md)とGate 0〜5の記録を、PoCの終了時点で評価したものである。PoCは「通常版Chromeをsession単位で分離して操作できるか」を調べるものであり、製品実装または製品readyの宣言ではない。

## 判定語

| 判定 | 意味 |
| --- | --- |
| `PASS` | 対象範囲の合格条件を、記載した証拠で満たした。実機・protocol・syntheticの範囲を併記する。 |
| `PARTIAL` | 重要な部分は確認したが、受入れに必要な経路またはclient・環境の一部が欠けている。 |
| `NOT TESTED` | 実行していない、または安全上・環境上の理由で判断を保留した。成功も失敗も推定しない。 |
| `FAIL` | 対象条件を実際に試し、条件を満たさない固定結果または停止を観測した。これはその受入れ項目の判定であり、全設計の失敗を意味しない。 |

「実現可能」と「製品ready」は別の判定である。後者には、readiness同期、実clientの全操作列、client matrix、運用・配布・復旧の追加受入れが必要である。

## 総合判定

**技術的実現可能性: `PARTIAL`。** Gate 0〜4で、専用Chrome/profile、Native Messaging、決定的pairing、6 browser tool、A/Bのprofile storage・操作分離、A限定停止からの復旧を、実機を含む複数の範囲で確認できた。G5-0〜4でもstdio、adapter、audit、process/lifecycleのprotocol・synthetic契約を確認できた。

一方、MCP serverのtool受付開始からExtension/Native Hostが`ACTIVE`になるまでのready境界が製品契約として成立していない。G5-6の決定的driver実機E2Eは、A/Bとも最初の`browser_status`で固定`transport_closed`となって停止した。したがって、Codex/Claudeの両方から実Chromeへ6 toolを通すend-to-endの成立は実証されていない。

**製品ready: `NOT READY`。** これは判定表の独立ラベルではなく、G5-6の`FAIL`、Codex実clientの`PARTIAL`、Claudeの`NOT TESTED`、および本番運用の未検証をまとめた結論である。PoCの「可能」は、本番品質・安全性・互換性の保証ではない。

## 要件単位の判定

| 要件 | 判定 | 実証範囲と根拠 |
| --- | --- | --- |
| session A/Bを専用Chrome instance・persistent profileへ1:1で割り当て、所有者不明のprocessを停止しない | `PASS` | [Gate 0](./gate-0-results.md)で専用profileの同時起動、二重割当拒否、A停止中のB継続を実機確認。 |
| Chrome ExtensionからNative Messaging Hostへ接続し、protocol以外をstdoutへ出さない | `PASS` | [Gate 1](./gate-1-results.md)で実機の最小往復、origin検証、再接続、codec境界を確認。 |
| 起動順、generation、lease、nonce、instance IDを明示的に扱い、旧binding・別instanceをfail-closedにする | `PASS` | [Gate 2設計](./gate-2-design.md)と[Gate 2実機結果](./gate-2-results.md)でA/B pairing、起動順反転、old generation拒否、A限定Host切断中のB継続を確認。 |
| `browser_status`、`tabs_list`、`navigate`、`snapshot`、`click`、`type`を明示対象へ相関させる | `PASS` | [status/tabs](./gate-3-status-tabs-results.md)、[navigate](./gate-3-navigate-results.md)、[snapshot](./gate-3-snapshot-results.md)、[click](./gate-3-click-results.md)、[type](./gate-3-type-results.md)で各作業単位とA/B実機経路を確認。 |
| freshなdocument参照を使い、stale documentとmutationの不確定結果を再送しない | `PASS` | [Gate 3 type結果](./gate-3-type-results.md)および[Gate 5計画](./gate-5-plan.md)で、fresh loader/node、`stale_document`、`outcome_unknown`、mutation no-retryを確認。 |
| 同一originでもA/Bのcookie、localStorage、tab、入力結果が混ざらず、A限定停止後もBが継続する | `PASS` | [Gate 4実機結果](./gate-4-results.md)でnear-concurrent操作、storage分離、A限定のExtension/Host/harness/Chrome停止とA復旧、B継続を確認。 |
| old response fence、private audit、MCP lifecycle/crash/restartをprotocolまたはsynthetic範囲で成立させる | `PASS` | [G5-0](./gate-5-g5-0-results.md)〜[G5-4](./gate-5-g5-4-results.md)でstdio、6 tool adapter、audit相関、socket/process lifecycleを確認。G5-4はSIGKILLしたprocess自身のcleanupを主張せず、次回起動時の安全回収境界を検証した。 |
| 実Codex clientがstdio serverを認識し、6 toolとstatus callを実行する | `PARTIAL` | [G5-5](./gate-5-g5-5-results.md)でdirect `-c` override、6 tool catalog、`browser_status{}` 1回、固定`transport_closed`、exit 0を確認。実Chromeでの全操作列は未確認で、project-scoped config方式は2回失敗した。 |
| 実Codex clientから実Chrome A/Bへ、6 toolの決定的操作列を通してstorage・marker分離を受入れる | `FAIL` | [G5-6](./gate-5-g5-6-results.md)でA/B各1回を実行したが、最初の`browser_status`が固定`transport_closed`となり、後続toolとmutationは0回。driverはPoC/test-only artifactとして凍結した。 |
| Claude Codeでも同じlocal stdio・実Chrome A/B受入れを確認する | `NOT TESTED` | Claude Codeは別端末保留であり、導入・実行していない。[Gate 5計画](./gate-5-plan.md)と[G5-5](./gate-5-g5-5-results.md)に記録。 |
| bot検知の回避、全CDP domain、Windows/Linux、installer・更新・長期運用を保証する | `NOT TESTED` | これらは[PoCの非目標](./poc-plan.md)であり、今回の成功・失敗から結論を出さない。 |

## 成立した範囲

- 1つのsessionが暗黙の「最後に接続したtab」へ流れるのではなく、明示的なinstance/profile・pairing・identity境界を持つ構造は、macOS上の通常版Chromeで成立した。
- Gate 3の6 browser toolは、PoCの固定契約と実Chrome A/B試験の範囲で成立した。Gate 4では同じorigin上の保存状態と操作結果が相互に混ざらないことも確認した。
- G5-0〜4は、実clientや実Chromeを含まない範囲で、stdio、tool schema、固定error、audit gate、旧connection fence、process lifecycleの契約を確認した。
- Codexについては、direct one-shot overrideによるstdio/status-onlyの接続境界が確認できた。これは6 toolの実Chrome操作やGate 5合格を意味しない。

## 成立条件

本実装へ進む場合、少なくとも次を仕様とテストで先に固定する。

1. MCP serverがbrowser toolを受け付ける前に、Extension/Native Hostの対象instanceが`ACTIVE`であることを示すready signalまたはbounded waitを完了する。
2. readiness timeout・disconnect・再接続を、read-only確認とmutation送信から分離する。mutationは送信済み結果が不確定なら自動再送しない。
3. Codexのstatus-onlyではなく、6 toolの順序、fresh snapshot、type/click各1回、最終snapshotまでを実clientで確認する。
4. clientごと、起動順ごと、A/B近接並行ごとの結果を同じ固定error・audit・privacy契約で比較できるようにする。
5. プロファイル所有、stale resource回収、権限、配布、更新、監視、依存ライセンスを製品工程として別途受入れる。

## 未解決リスク

- readiness signalがないまま最初の接続依存toolを送るraceが残っている。今回のG5-6観測だけからChrome、Extension、Native Hostの単独原因は断定できない。
- 実clientで確認できたのはCodexのstatus-only partial passだけであり、Claudeおよびclient終了・resumeを含む全操作列は未知である。
- Gate 4の実機で、旧Native Messaging transportを保持して悪意あるlate responseを再送するadversarial試験は、安全な保持手段がないため未実施である。state/socket/Hostのsynthetic fenceを代替証拠とした。
- lease renewal/rotation、長期運用、配布・更新、複数OS、権限変更後の復旧はPoCの範囲外または未実装である。
- `screenshot`、全CDP domain、bot検知の挙動、対象サイトごとのpolicy・利用規約・許可条件は、このPoCから保証できない。

## 停止・保留した検証

- G5-6はA/B各1回の契約に従い、最初の`browser_status`が固定`transport_closed`となった時点で停止した。mutationや不確定結果のretryは行っていない。readiness polling/notification/waitをPoCへ追加して再実行することもしなかった。
- Claude Codeはこの端末にアカウントがなく、別端末検証へ保留した。未実行を成功扱いにしない。
- Gate 4の実機late-response adversarial testは、危険な旧transport保持経路を新設しないため実施しなかった。
- `screenshot`と、PoC非目標の全CDP・他OS・長期運用試験は実施していない。

## 証拠文書と凍結境界

- [PoC実装計画](./poc-plan.md): 目的、非目標、identity・privacy・no-retryの不変条件。
- [Gate 4実行計画](./gate-4-plan.md) / [Gate 4実機結果](./gate-4-results.md): 実Chrome A/B isolation acceptance。
- [Gate 5計画](./gate-5-plan.md): MCP境界とclient受入れ条件。
- [G5-6 deterministic driver仕様](./gate-5-deterministic-driver.md) / [G5-6結果](./gate-5-g5-6-results.md): 凍結したPoC/test-only driverと未成立の実機E2E。

PoC source、driver、runtime、profile、手動操作手順を製品コードへコピーしない。次の工程は、これらの証拠から契約を抽出し、[本実装引き継ぎ仕様](./product-reimplementation-handoff.md)を入力としてゼロから再設計・再実装する。
