# Gate 1 実機試験結果

## 実施情報

- 実施日: 2026-09-04
- 環境: macOS 15.7.4、Node.js v26.7.0、通常版 Google Chrome 152.0.7977.76
- 対象: PoC launcherが作成した専用Chrome instance、unpacked Extension、PoC生成のNative Messaging Host

実行ファイルの絶対path、PID、profile path、cookie、page data、extension keyの秘密値はこの記録に含めない。

## 非GUI検証

| 項目 | 結果 |
| --- | --- |
| 固定extension IDのpublic key導出と`nativeMessaging`だけへのpermission限定 | 成功 |
| Native Messagingのpartial frame / 複数frame / 不正JSON / 上限超過 | 成功 |
| Host→Extension 1 MiB、Extension→Host 64 MiBの方向別上限 | 成功 |
| origin完全一致、stdoutのprotocol専用化、success markerの安全な書込み | 成功 |
| instanceごとのmanifest/wrapper導入・安全なinstall / uninstall | 成功 |
| Chrome instanceの停止・stale claim復旧の安全条件 | 成功 |

`npm test`で22件すべてが成功した。

## 実機で確認した経緯

| 手順・事象 | 結果と判断 |
| --- | --- |
| `--load-extension`で専用Chromeを起動 | Chrome 152ではExtensionが導入されなかった。通常版ChromeではChrome 137以降この導入方法を使えないため、手動導入へ切り替えた。 |
| 専用profileの`chrome://extensions`からDeveloper modeと**Load unpacked**を使用 | Extensionを専用profileへ導入できた。launcherはExtensionを自動導入しない。 |
| Native Host manifestを通常Chromeの既定ユーザー領域へ導入 | `Specified native messaging host not found.` が発生した。`--user-data-dir`を指定したChromeは、この通常領域をユーザー単位の探索先として使わない。 |
| manifest導入先をinstance-awareに修正 | manifestを専用`user-data-dir`直下の`NativeMessagingHosts/`へ導入する方式に変更した。`Default/`配下には置かず、instance IDを明示するCLIで導入先を決定する。 |
| ExtensionからHostへ接続 | `hello` → `hello_ack` → `ack`の完了により、success markerが2026-09-04T21:32:55+09:00に初回生成された。 |
| ExtensionをReloadして再接続 | success markerが2026-09-04T21:43:09+09:00へ更新され、disconnect後の再接続を確認した。 |

通常版Chromeでの手動導入が必要な点は、Chrome ExtensionsチームによるChrome 137以降の`--load-extension`廃止案内と整合する。[公式announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY)

## 判定

**Gate 1: 合格**

専用Chrome instanceからNative Hostを起動し、Extension originの検証を通過した最小protocolの往復と、Extension Reload後の再接続を実機で確認した。HostはstdoutへNative Messaging protocol以外を出力しない。

## Gate 2へ持ち越す制約

- 通常版Chromeでは、専用profileの`chrome://extensions`からDeveloper modeを有効にし、**Load unpacked**でExtension directoryを選択する必要がある。
- Native Messaging manifestの導入・削除は、対象instance IDを明示して行う。通常Chromeの設定領域や別instanceのprofileには導入しない。
- Gate 1は1 instanceとNative Messagingの疎通までを対象とする。複数instance間の決定的pairing、lease、再接続時のroutingはGate 2で検証する。
