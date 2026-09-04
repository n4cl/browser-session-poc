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

通常版Chrome 137以降では、launcherは`--load-extension`でunpacked Extensionを導入しない。Gate 1を実機確認するときは、PoC Native Messaging manifestを導入した後に次を実行する。

```sh
npm run chrome -- provision poc-gate1
```

専用profileの`chrome://extensions`が開く。Developer modeを有効にし、**Load unpacked**でコマンド出力の`manual_extension_directory`を選択する。導入後にのみ、ExtensionがNative Hostへ接続する。通常の`start`は`about:blank`を開き、Extensionを自動導入しない。

詳細は[Gate 1実機試験結果](./docs/gate-1-results.md)を参照する。
