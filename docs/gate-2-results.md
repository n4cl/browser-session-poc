# Gate 2 単一instance実機試験結果

## 実施情報

- 実施日時: 2026-09-05T12:53:30+09:00
- 環境: macOS 15.7.4 (24G517)、Google Chrome 152.0.7977.76、Node.js v26.7.0
- 対象: 専用PoC Chrome instance、Extension、Native Host、前景pairing harness

この記録には絶対path、PID、cookie、descriptor、session ID、lease ID、nonceその他の秘密値を含めない。

## 実機で通過した単一instance経路

staleな旧claimを安全条件下で回収し、generation更新後にOptions画面から保存bindingを明示的にresetした。続くinitial pairingは`ACTIVE`となり、identity付きpingも成功した。

通常のExtension Reload後も同じbindingによるresumeが`ACTIVE`となり、pingに成功した。旧Service Worker / 旧Hostの正常終了をerrorとして表示していたfalse positiveは、ACTIVE後の切断を再接続予定のwarningへ変更した。既存errorを消去した状態で、再確認時に新しいerrorは表示されなかった。

安全挙動として、harness消失時は期限切れdescriptorに対してHostが終了し、fail-closedとなることを確認した。stale claim recoveryは実装済みである。

## 判定

**Gate 2全体の合格ではない。単一instance経路の実機通過。**

未検証:

- A/B同時実機
- 起動順の反転
- BがAのclaimまたはconnectionを奪わないこと
- AのHost crash中にBが継続すること

## 現在の制約

- lease renewalは未実装。PoC harnessの既定leaseは1時間であり、満了時はACTIVEでも`REVOKED`となる。
- rotationの自動化は未実装。保存bindingの削除はOptions画面からの明示操作だけを提供する。
