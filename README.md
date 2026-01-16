# DocFolderPdfWatcher

UIなしで常駐し、指定フォルダに投入された Word/Excel を LibreOffice (headless) で PDF 変換する Windows アプリです。

## 使い方

1. GitHub Actions の成果物 zip を展開します。
2. `DocFolderPdfWatcher.exe` を起動します。
3. `data/inbox` に Word/Excel ファイルをコピーします (D&D)。
4. 変換後の PDF は `data/inbox` に保存されます。

※ 自動起動は実装していません。必要なら `schtasks` を用いてログオン時起動を設定してください。

## フォルダ構成 (既定)

- `data/inbox` : 監視フォルダ
- `data/work` : 変換用コピー置き場
- `data/output` : （未使用。既定では `data/inbox` に PDF を出力）
- `data/archive/originals` : 原本アーカイブ
- `data/archive/work` : 変換成功のコピーアーカイブ
- `data/archive/work_failed` : 変換失敗のコピーアーカイブ
- `data/logs/app.log` : アプリログ
- `data/logs/jobs.ndjson` : ジョブログ
- `data/state/processed.json` : 再処理防止の簡易DB

## 開発・ビルド

```bash
npm ci
npm run ci:win
```

### npm scripts

- `dev`: ts-node で監視起動
- `build`: TypeScript をビルド
- `vendor:lo`: LibreOffice をダウンロードして展開し、dist に同梱
- `pack:exe`: `pkg` で exe 作成
- `package:zip`: dist を zip 化
- `ci:win`: `vendor:lo` → `build` → `pack:exe` → `package:zip`

## 設定

`dist/config/config.json` を編集してください。存在しない場合は実行時に生成されます。

## ライセンス表記

`dist/licenses/MPL-2.0.txt` と `dist/THIRD_PARTY_NOTICES.txt` を同梱しています。
