# browser-session-poc

Codex / Claude Codeの各sessionに、専用のGoogle Chrome instanceとpersistent profileを割り当てられるか検証するための使い捨てPoC。

- [PoC実装計画](./docs/poc-plan.md)

現在は技術的実現可能性を確認するspike段階であり、本番利用を想定した実装ではない。

## Gate 0 の非GUI確認

`npm test` はPoCのテストだけを実行する。research配下は意図的に対象外である。

```sh
npm test
npm run chrome -- plan poc-a
npm run chrome -- plan poc-b
```

`start` は実際にChromeを起動するため、Gate 0の非GUI確認には含めない。起動前にmacOSのprocess inspectionが利用可能か確認し、利用できない環境ではChromeを起動しない。`stop` は記録済みのPID、起動時刻、Chrome実行ファイル、専用profile引数が全て一致するときだけ停止する。終了を確認できない場合はinstance claimを保持し、同じprofileの再起動を拒否する。

## Gate 1 の手動Extension導入

通常版Chrome 137以降では、launcherは`--load-extension`でunpacked Extensionを導入しない。Gate 1を実機確認するときは、対象instanceのPoC Native Messaging manifestを導入した後に次を実行する。

```sh
npm run native-host -- install poc-gate1
npm run chrome -- provision poc-gate1
```

Native Messaging manifestは、通常Chromeの設定領域ではなく、`poc-gate1`の専用user-data-dir直下の`NativeMessagingHosts/`へ導入される。`Default/`配下には置かない。`plan`・`uninstall`も同じinstance-idを明示する。

```sh
npm run native-host -- plan poc-gate1
npm run native-host -- uninstall poc-gate1
```

専用profileの`chrome://extensions`が開く。Developer modeを有効にし、**Load unpacked**でコマンド出力の`manual_extension_directory`を選択する。通常の`start`は`about:blank`を開き、Extensionを自動導入しない。

詳細は[Gate 1実機試験結果](./docs/gate-1-results.md)を参照する。

## Gate 2 Native Host wrapper

`install`が生成するwrapperは、固定されたruntime rootとinstance-idをHostへ引数で渡す。Hostはそのinstanceのprofile metadataとactive descriptorだけを0600・非symlink・期限の条件で再検証し、descriptorが指定したsession socketだけへ接続する。他instanceの探索やGate 1への自動fallbackはしない。

Gate 1の`hello`/`ack`は直接Hostを起動する既存テスト互換のためだけに残している。生成wrapperからの経路は、`pair_start`または保存済みidentity tuple付きの`resume_start`で始めるGate 2 protocol専用である。

現時点のExtensionはまだGate 2 protocolを送らないため、このwrapperを導入した実機のend-to-end検証は次のExtension実装単位まで保留する。Gate 1の実機結果は過去の確認記録として保持している。
