# Gate 3 browser_status / tabs_list 実機試験結果

## 実施情報

- 実施日時: 2026-09-07
- 環境: macOS 15.7.4 (24G517)、Google Chrome 152.0.7977.76、Node.js v26.7.0
- 対象: 専用PoC Chrome instance A/B、Extension、Native Host、前景pairing harness

この記録にはprofile path、PID、session ID、browser/profile instance ID、generation、lease ID、nonce、URL、title、cookieその他の秘密値を含めない。

## 目的

Gate 2で確立したinstance専用のExtension → Native Host → session socket経路を保ったまま、最初のGate 3 read-only toolである`browser_status`と`tabs_list`が、A/Bで混線せず実Chromeから応答できることを確認する。

## 手順

1. A/Bそれぞれでsession専用pairing harnessと専用profileの通常Google Chromeを起動した。
2. generation変更により保存済みbindingが古くなったprofileでは、Extension Optionsから明示的にbindingをresetしてreloadした。
3. A/Bがともに`ACTIVE`であることを確認した。
4. Aで`browser-status`、`tabs-list`、`ping`を実行した。
5. Bで同じ3 commandを実行した。
6. Bの実行後にAで`browser-status`と`tabs-list`を再実行し、最後にA/Bの`ACTIVE`継続を確認した。

`browser-status`と`tabs-list`は、各実行ごとに新しいrequest IDと1,000 ms timeoutを使用した。対話CLIは実値を含み得るfieldを画面上にだけ表示し、本記録へ転記していない。

## 期待結果と実結果

| 確認項目 | 期待結果 | 実結果 |
| --- | --- | --- |
| A初期phase | `ACTIVE` | `ACTIVE` |
| A `browser-status` / `tabs-list` / `ping` | すべて成功 | すべて成功、タブ件数 1 |
| B初期phase | `ACTIVE` | `ACTIVE` |
| B `browser-status` / `tabs-list` / `ping` | すべて成功 | すべて成功、タブ件数 1 |
| B実行後のA再確認 | Aが継続し両command成功 | `ACTIVE`継続、両command成功、タブ件数 1 |
| 最終phase | A/Bとも`ACTIVE` | A/Bとも`ACTIVE` |

各応答は、当該harnessのcurrent descriptorに対する`browser_instance_id`、`profile_instance_id`、generation、lease IDの照合を通過した。A/Bの応答を入れ替えたものやidentity不一致の応答は実行経路上で受理されないため、成功したcommandについてクロスルーティングは観測されなかった。

## 試験中の復旧事象

- BはExtension reload/resetを挟んだ初回candidate connectionが`pair_ack`前に切断され、短時間で`REVOKED`となった。旧harnessを正常cleanupして新generationのharnessを開始すると、Extensionは`ACTIVE`へ復帰した。これは初期candidate切断時にfail-closedでdescriptorをrevokeする設計どおりの挙動である。
- Aの`REVOKED`はBの起動・command実行後に発生したように見えたが、descriptorの発行時刻と期限、現在時刻を照合すると、既定1時間leaseの満了後だった。state machineのlease expiry経路と一致しており、Bによる干渉ではなかった。

## 判定と制約

**browser_status / tabs_list の作業単位は実機合格。** A/Bの交互実行、Aの再確認、identity tuple照合、タブ取得、ping継続を確認した。

ただし、Gate 3全体は`navigate`以降のtoolが未実装であるため、Gate 3自体を合格とはしない。

現行PoCの制約:

- harnessの既定leaseは1時間であり、満了すると`ACTIVE`でも`REVOKED`になる。renewalは未実装である。
- 新generationでは古い保存bindingを自動利用しない。各profileでOptionsからの明示的なbinding reset/reloadが必要である。
- 実機記録にはURL、title、identity tuple、認証情報その他の実値を保存しない。
