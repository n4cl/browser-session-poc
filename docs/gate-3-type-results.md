# Gate 3 type 実機試験結果

対象環境は専用PoC Chrome A/B、各instance専用profile、pairing harness、session socketである。この記録にはURL、title、tab ID、loader ID、backend DOM node ID、PID、session ID、generation、lease、nonceその他のruntime実値を保存しない。

## 目的

同じdocumentから取得したsnapshotのloader/node参照で`type`を実行し、A/Bのnear-concurrent操作がそれぞれのprofile・tab・documentへ相関したまま届くことを確認する。入力文字列がresponseやログへ漏れないこと、loader不一致を`stale_document`として拒否することも確認する。

## 手順

1. Extension 0.0.4をA/Bへ管理reloadし、freshな`DevToolsActivePort`を待つ管理経路がユーザー操作なしで完了することを確認した。A/Bとも新しい24時間harnessで別generationとなり、自動rebind後に`ACTIVE`へ復帰した。
2. A/Bそれぞれのlocalhost入力ページへ`navigate`し、fresh snapshotから各ページの別tab・loaderと入力対象のbackend DOM nodeを内部で選択した。
3. A/Bへnear-concurrentに`type`を発行した。Aは日本語と空白を含む固有文字列、Bは英数字と空白を含む固有文字列を使用した。
4. 両方のresponseが`accepted: true`となることを確認した。成功responseにはtext本文が含まれず、PTYの入力エコーは結果評価から除外した。
5. 直後にA/Bのsnapshotを取得し、各ページで対応する固有valueと固有title/statusだけが変化し、loaderが継続していることを確認した。A/B双方で`ping`が成功し、phaseが`ACTIVE`であることも確認した。
6. Aだけをnavigateした後、旧loaderと旧backend DOM nodeで`type`を試し、`stale_document`となることを確認した。その後、Aの`ping`が成功しphaseが`ACTIVE`であることを再確認し、post snapshotでは入力が空のままであることを確認した。
7. A/B間のcross-routingとNative Host終了がないことを確認し、localhost serverと一時ファイルを削除した。

## 実結果

| 確認項目 | 実結果 |
| --- | --- |
| Extension更新 | A/Bとも0.0.4の管理reloadが成功。fresh endpointのbounded pollingを経て通常起動へ復帰 |
| 自動rebind | A/Bとも別generationで`ACTIVE`へ復帰 |
| type対象 | A/Bともfresh snapshot由来の別tab・loader・入力node |
| near-concurrent type | A/Bとも`accepted: true` |
| text非露出 | 成功response、通常ログ、固定診断、errorにtext本文なし。PTY入力エコーは除外 |
| type後snapshot | A/B各ページで対応する固有valueと固有title/statusだけが変化。loader継続 |
| stale document | Aのnavigate後、旧loader/nodeは`stale_document`。入力は変更されなかった |
| 事後疎通 | A/Bとも`ping`成功、phaseは`ACTIVE` |
| 分離 | cross-routingなし、Native Host終了なし |

## 判定と制約

**type作業単位の実機試験は合格。Gate 3は合格と判定する。** `browser_status`、`tabs_list`、`navigate`、`snapshot`、`click`、`type`について、自動テストと必要なA/B実Chrome試験を完了した。

`type`は既存値の末尾への挿入であり、置換・clearではない。timeout、transport切断、`Input.insertText`送信後の不確定な失敗は`outcome_unknown`として自動retryしない。`screenshot`は必要時だけ追加する計画上の任意機能であり、今回のGate 3合格条件には含めず、未実装である。
