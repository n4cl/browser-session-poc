# Gate 2 A/B実機試験結果

## 実施情報

- 実施日時: 2026-09-05〜2026-09-06
- 環境: macOS 15.7.4 (24G517)、Google Chrome 152.0.7977.76、Node.js v26.7.0
- 対象: 2つの専用PoC Chrome instance、Extension、Native Host、前景pairing harness

この記録には絶対path、PID、cookie、descriptor、session ID、lease ID、nonceその他の秘密値を含めない。

## 実機で通過した単一instance経路

staleな旧claimを安全条件下で回収し、generation更新後にOptions画面から保存bindingを明示的にresetした。続くinitial pairingは`ACTIVE`となり、identity付きpingも成功した。

通常のExtension Reload後も同じbindingによるresumeが`ACTIVE`となり、pingに成功した。旧Service Worker / 旧Hostの正常終了をerrorとして表示していたfalse positiveは、ACTIVE後の切断を再接続予定のwarningへ変更した。既存errorを消去した状態で、再確認時に新しいerrorは表示されなかった。

安全挙動として、harness消失時は期限切れdescriptorに対してHostが終了し、fail-closedとなることを確認した。stale claim recoveryは実装済みである。

## A/B同時実機で通過した経路

Round 1ではB→Aの順でharnessを起動した。AだけにExtensionを導入した時点では、Aは`ACTIVE`でping成功、Bは`ISSUED`でping失敗だった。Bにも導入後は両方が`ACTIVE`となり、A→B→Aの順のpingはすべて成功した。

AのExtensionを通常reloadした後も、Aは保存済みbindingでresumeして`ACTIVE`とping成功へ戻った。その前後でBは`ACTIVE`とping成功を維持した。

AのACTIVE Native Host transportだけをPoCの`disconnect-active-host`で切断した。直後のBは`ACTIVE`とping成功を維持し、Aは同じbindingで自動resume後にping成功した。続くBのpingも成功した。

Round 2では両harnessを正常終了してclaimとactive descriptorのcleanupを確認してから、A→Bの順で新しいharnessを起動した。新generationでは古い保存bindingを自動で消去せず、A/Bとも`ISSUED`かつping失敗となった。AだけをOptions画面から明示resetした時点ではAだけが`ACTIVE`とping成功、Bは`ISSUED`とping失敗だった。Bも明示reset後は両方が`ACTIVE`となり、再度のA→B→A pingはすべて成功した。

## Gate 2条件と証拠

| 合格条件 | 実機証拠 | 自動テストの証拠 |
| --- | --- | --- |
| 起動順を入れ替えても対応instanceへpairingする | Round 1のB→A、Round 2のA→Bで、ともにA/Bが独立して`ACTIVE`/ping成功 | instance path、claim、descriptor、socketのA/B分離と起動順反転を検証 |
| B起動時にAの接続を奪わない | A/Bの連続ping、およびA reload中・A transport切断直後のB pingが継続成功 | A/B socket分離、lease fencing、別instance失敗時のA不変を検証 |
| nonce再利用、旧generation、別instance IDを拒否する | 新generationで保存bindingを自動推測せず`ISSUED`へfail-closedし、Options明示reset後だけinitial pairing | nonce一回利用、connection ID再利用、旧generation/lease/tuple不一致、別instance descriptorを拒否する検証 |
| AのHost crash/reconnect中もBが継続する | Aのactive Host transportを限定切断し、Bのping継続とAの自動resumeを確認 | active connectionのfencing、pending ping失敗、disconnect→resume→ping、A/B独立を検証 |

`npm test`は2026-09-06に85件すべて成功した。

## 判定

**Gate 2合格。** A/B同時pairing、起動順反転、old generationのfail-closed、A限定Host切断中のB継続とA resumeを、実機と自動テストで確認した。

## 現在の制約

- lease renewalは未実装。PoC harnessの既定leaseは1時間であり、満了時はACTIVEでも`REVOKED`となる。
- rotationの自動化は未実装。保存bindingの削除はOptions画面からの明示操作だけを提供する。
