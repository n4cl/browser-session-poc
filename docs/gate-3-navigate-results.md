# Gate 3 navigate 実機試験結果

実行日: 2026-09-07

対象環境:

- macOS 15.7.4（build 24G517）
- Google Chrome 152.0.7977.76
- Node.js v26.7.0

## 目的

Gate 3の`navigate`作業単位について、A/Bそれぞれの専用profile・pairing harness・session socketを使い、`chrome.tabs.update`が自instanceのtabだけに受理されること、および同時に近い要求で結果が混ざらないことを確認する。

この記録にはURL、title、tab ID、identity tuple、nonce、leaseなどの実値を保存しない。

## 手順と期待結果

1. A/Bをそれぞれ新generationでpairingし、各phaseが`ACTIVE`であることを確認する。
2. 各`tabs-list`から自profile内の操作可能なtabを1件だけ内部選択する。
3. A/Bへ互いに異なる、非認証・非secretの`https`テストtargetを近接並行で各1回だけ`navigate`する。
4. 各responseが`accepted`となることを確認する。これは`chrome.tabs.update`が受理したことを意味し、page loadの完了・外部ページの到達を保証しない。
5. 各`tabs-list`を再実行し、選択した同一tabが自分のcanonical targetと一致し、相手targetとは一致しないことを確認する。
6. 各harnessのdescriptorに対するidentity tuple、generation、connection相関を内部確認し、A/Bの`browser-status`、`ping`、最終phaseが成功・`ACTIVE`であることを確認する。

## 実結果

- A/Bとも初期・最終phaseは`ACTIVE`だった。
- A/Bとも`tabs-list`はnavigate前後で各1件だった。
- `tabs-list`、`navigate`、事後`tabs-list`、`browser-status`/`ping`/最終statusの各段階を、A/B間では並行に発行した。各CLI session内では順序を保った。
- A/Bの`navigate`は各1回だけで、双方`accepted`だった。timeout、`outcome_unknown`、自動retryは発生しなかった。
- 各選択tabは自instanceのcanonical targetに一致し、相手instanceのtargetとは不一致だった。identity tupleとdescriptorの照合も各instanceで成功した。
- A/B双方の`browser-status`と`ping`は成功した。

判定: `navigate`作業単位の実機試験は合格とする。ただしGate 3全体は`navigate`以降の`snapshot`、`click`、`type`などが未実装のため、未合格である。

## 運用上の観測と制約

- 試験中にharnessのPTY参照が失われた事象はbrowser機能の不具合ではなく、実行環境のPTY参照喪失だった。claimのinstance/runtime root・private file属性・schemaとprocess identity（開始時刻・command）を完全照合したうえで対象harnessだけへSIGTERMを送り、claim、descriptor、socket、processのcleanupを確認した。
- `pairing-session`には現時点で明示的なstop CLIがない。harness終了は対話`quit`または、上記のように所有を完全照合した限定的な回収手順で行う。
- descriptor leaseは1時間であり、generation変更後はExtensionの明示的なbinding reset/reloadが必要である。
- `navigate`のtimeoutまたはtransport喪失は結果不明の`outcome_unknown`として扱い、自動retryしない。
