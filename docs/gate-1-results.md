# Gate 1 実機試験結果

## 実施情報

- 実施日時: 2026-09-04T13:59:49+09:00 から 2026-09-04T14:01:15+09:00
- 環境: macOS 15.7.4、Node.js v26.7.0、通常版 Google Chrome 152.0.7977.76
- 対象: PoC launcherが作成した専用Chrome instanceと、PoC生成のNative Messaging manifestだけ

実行ファイルの絶対path、PID、profile path、cookie、page data、extension keyの秘密値はこの記録に含めない。

## 非GUI検証

| 項目 | 結果 |
| --- | --- |
| 固定extension IDのpublic key導出 | 成功 |
| Manifest permissionを`nativeMessaging`だけに限定 | 成功 |
| Native Messagingのpartial frame / 複数frame / 不正JSON / 上限超過 | 成功 |
| Host→Extension 1 MiB、Extension→Host 64 MiBの方向別上限 | 成功 |
| origin完全一致、stdoutのprotocol専用化、0600 success marker | 成功 |
| manifest/wrapperの安全なinstall・uninstall | 成功 |

`npm test`で16件すべてが成功した。

## 実機で実施した論理手順と結果

| 手順 | 期待結果 | 実結果 |
| --- | --- | --- |
| PoC専用Native Messaging manifestを導入 | 自身が生成する内容だけを導入する | 成功 |
| 専用Chrome instanceを、`--load-extension`付きで起動 | ExtensionがHostへ`hello`を送る | Chrome起動は成功したがsuccess marker未生成 |
| Extensionの起動イベントを明示して再起動 | `hello`→`hello_ack`→`ack`後にmarkerを生成する | success marker未生成 |
| launcher経由でPoC Chromeを停止 | 所有instanceだけを停止する | 成功 |
| PoC Native Messaging manifestを削除 | 自身が生成した内容と一致する場合だけ削除する | 成功 |

## 判定

**Gate 1: Native Messagingは未判定、Extension provision経路は不合格**

Host単体とcodecの契約は検証できたが、Chrome 152では`--load-extension`によりExtensionが導入されていなかった。専用profileのPreferences、Secure Preferences、Local Stateに固定Extension ID/nameが存在しないことを確認した。したがってsuccess marker未生成はNative Messagingの不成立を示すものではなく、Extensionが起動していないことによる。

Chrome Extensionsチームは、official branded ChromeではChrome 137以降`--load-extension`を廃止したと案内している。[公式announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY)

## 残る制約と次の調査候補

- 通常版Chromeでは、専用profileの`chrome://extensions`からDeveloper modeを有効にして**Load unpacked**を選び、Extension directoryを明示的に指定する必要がある。
- 手動導入後に、Native Host manifestの探索、Host起動、`hello`→`hello_ack`→`ack`を改めて確認する必要がある。
- launcherはExtensionを自動導入しない。`provision` commandは専用profileの`chrome://extensions`を開き、選択すべき絶対directoryを案内するだけである。
