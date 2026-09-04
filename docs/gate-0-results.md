# Gate 0 実機試験結果

## 実施情報

- 実施日時: 2026-09-04T13:51:39+09:00 から 2026-09-04T13:52:44+09:00
- 環境: macOS 15.7.4、Node.js v26.7.0、通常版 Google Chrome
- 対象: PoC launcherが作成した `poc-a` と `poc-b` だけ

profileの絶対パス、PID、cookie、ページ内容はこの記録に含めない。

## 実行した論理手順と結果

| 手順 | 期待結果 | 実結果 |
| --- | --- | --- |
| `poc-a`を専用profileで起動 | instance Aがrunningになる | 成功 |
| `poc-b`を専用profileで起動 | instance Bがrunningになり、Aとprofile・PIDが異なる | 成功 |
| A/Bのstatusを確認 | 両方がrunningで、記録済みidentityと一致する | 成功 |
| `poc-a`を二重起動 | claimにより起動前に拒否される | 成功。二重起動は拒否された |
| launcherで`poc-a`を停止 | identity照合後にAだけ停止する | 成功 |
| `poc-b`のstatusを再確認 | A停止後もBはrunningのまま | 成功 |
| launcherで`poc-b`を停止 | identity照合後にBを停止し、終了確認後にclaimを解放する | 成功 |

## 判定

**Gate 0: 合格（macOS実機試験済み）**

専用`--user-data-dir`を使う2 instanceの同時起動、同一instanceの二重割当拒否、所有Chromeだけの停止、A停止中のB継続を確認できた。stopはPID、起動時刻、実行ファイル、専用profile引数を照合した後、終了確認までclaimを保持した。

## 残る制約

- この確認はmacOS 15.7.4とこのChrome環境に限る。Chrome更新後も再確認が必要である。
- process inspectionが許可されない環境では、安全のためlauncherはChromeを起動しない。
- Native Messaging、Extension pairing、cookie/localStorageの相互隔離、crash recoveryは未検証であり、次のGate以降の対象である。
