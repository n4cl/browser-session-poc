# Gate 3 click 実機試験結果

実施日: 2026-09-10

対象環境は専用PoC Chrome A/B、各instance専用profile、pairing harness、session socketである。この記録にはURL、title、tab ID、loader ID、backend DOM node ID、PID、session ID、generation、lease、nonceその他のruntime実値を保存しない。

## 目的

同じdocumentから取得したsnapshotのloader/node参照でclickを実行し、A/Bのnear-concurrent操作がそれぞれのprofile・tab・documentへ相関したまま届くこと、click後の状態変化と接続状態が混線しないことを確認する。

## 手順

1. Extension 0.0.3をA/Bへ管理reloadし、ユーザー操作なしで両方が自動rebindして`ACTIVE`となり、`ping`が成功することを確認した。
2. 旧長期pairing CLIが`click`を`unknown_command`として扱ったため、そのCLIを正常`quit`した。これは実行中Nodeプロセスが旧コードを保持していたためで、製品実装の不具合ではない。新コードでA/B harnessを24時間leaseとして起動し、generation更新後の自動rebindと`ACTIVE`復帰を確認した。
3. A/Bそれぞれのlocalhostページからfresh snapshotを取得し、別loader、別tab、各ページ固有のbuttonとbackend DOM nodeを内部で選択した。
4. A/Bへnear-concurrentにclickを発行し、両方の応答が`accepted: true`となることを確認した。
5. 直後にA/Bのsnapshotを取得し、AにはA固有のclicked/done状態だけ、BにはB固有のclicked/done状態だけが現れ、loaderが継続していることを確認した。
6. Aだけをnavigateした後、旧loaderと旧backend DOM nodeでclickを試し、`stale_document`となることを確認した。その後もA/Bの`ping`とphaseは正常な`ACTIVE`だった。
7. A/B間のcross-routingとNative Host終了がないことを確認し、localhost server停止と一時ファイル削除を完了した。

## 実結果

| 確認項目 | 実結果 |
| --- | --- |
| Extension更新 | A/Bとも管理reloadで0.0.3を反映 |
| 自動rebind | A/Bともgeneration更新後に`ACTIVE`へ復帰 |
| 初期疎通 | A/Bとも`ping`成功 |
| click対象 | A/Bともfresh snapshot由来の別tab・別loader・固有button/node |
| near-concurrent click | A/Bとも`accepted: true` |
| click後snapshot | AはA固有状態のみ、BはB固有状態のみ。loader継続 |
| stale document | Aのnavigate後、旧loader/nodeは`stale_document` |
| 事後疎通 | A/Bとも`ping`成功、`ACTIVE`継続 |
| 分離 | cross-routingなし、Native Host終了なし |

## 判定と制約

**click作業単位の実機試験は合格。** A/Bのnear-concurrent click、click後状態、loader相関、stale document拒否、接続継続を確認した。

ただし、Gate 3全体は`type`が未実装・未合格のため、Gate 3自体は引き続き未合格とする。
