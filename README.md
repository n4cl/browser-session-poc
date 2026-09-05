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

Extensionの`storage` permissionは、`pair_active`で確定したbinding（session/browser/profile/generation/lease）だけを保存し、次回に同じinstanceへ`resume_start`するために使う。challengeやnonceは保存しない。

保存済みbindingが古くなった場合は、自動で消去されない。対象PoC Chromeで`chrome://extensions`を開き、この拡張機能の「詳細」から「拡張機能のオプション」を開く。「保存済みの接続情報を削除して再読み込み」を選ぶと、bindingを削除してから拡張機能を再読み込みし、次回は`pair_start`から開始する。

Gate 1の`hello`/`ack`は直接Hostを起動する既存テスト互換のためだけに残している。生成wrapperからの経路は、`pair_start`または保存済みidentity tuple付きの`resume_start`で始めるGate 2 protocol専用である。

ExtensionはGate 2 protocolで初回pairingと同一bindingのresumeを行う。generationまたはleaseが保存済みbindingと異なる場合は、自動でresetやlease rotationを推測せずfail-closedにする。明示的なrotation/resetは後続のsession harness実装で扱う。Gate 1の実機結果は過去の確認記録として保持している。

`npm run pairing -- start <instance-id>` は前景session harnessを開始する。起動時に既存claimを検出した場合は、記録済みprocess identityと全プロセス列挙で生きたharnessがいないことを確認してからのみ回収する。旧claim形式は、対応descriptorの期限切れ、socket接続不能、該当harnessプロセス不在の全条件が必要である。不明なclaim、descriptor、socket、process状態はfail-closedで保持する。
