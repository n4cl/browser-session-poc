# Gate 3 snapshot 実機試験結果

実施条件: `reload-extension` 修正後の専用PoC Chrome A/B

この記録にはURL、title、tab ID、loader ID、PID、session ID、browser/profile instance ID、generation、lease ID、nonceその他のruntime実値を保存しない。

## 目的

Accessibility snapshotが、A/Bそれぞれの専用profile・generation・tabへ相関したまま、近接並行実行でも混線せず返ることを確認する。あわせて、管理用Extension reload後の自動rebindとACTIVE継続を確認する。

## 手順

1. 管理用`reload-extension`を実行し、ユーザー操作なしで対象PoC Chromeが通常起動へ復帰することを確認した。
2. A/Bをそれぞれ別generation・別tabで`ACTIVE`にした。
3. A/BへPromise.all相当のnear-concurrentな`snapshot`を発行した。
4. 各応答のgenerationとtab IDが、対応する要求と一致することを確認した。
5. 直後にA/Bで`ping`、`status`を実行し、両方が`ACTIVE`であることを確認した。

## 実結果

| 確認項目 | 実結果 |
| --- | --- |
| 管理reload | ユーザー操作なしで完了し、自動rebind後に`ACTIVE`へ復帰 |
| A/Bの分離 | 別generation・別tabで実行 |
| snapshotの並行実行 | A/Bとも成功 |
| snapshot node数 | A/Bとも12件 |
| `truncated` | A/Bとも`true` |
| `partial` | A/Bとも`false` |
| `loader_id` | A/Bで相互に異なる |
| 応答相関 | generation・tab IDとも各要求と一致 |
| 直後の疎通 | A/Bとも`ping`成功、`status`は`ACTIVE` |
| クロスルーティング | 観測なし |
| Native Host終了 | 観測なし |

`truncated: true`は実機のsnapshotが現在のbounded出力制約に従って省略を示した結果であり、`partial: false`と併存した。raw CDP、URL、titleなどの実値は記録していない。

## 判定と制約

**snapshot作業単位の実機試験は合格。** 管理reload後の自動rebind、A/Bのgeneration・tab分離、近接並行snapshotのresponse相関、直後のACTIVE継続を確認した。

ただし、Gate 3全体は`click`と`type`が未実装・未合格であるため、Gate 3自体は引き続き未合格とする。
