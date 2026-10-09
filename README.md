# 🍱 週末作り置き献立（移転しました）

このアプリは **[stock.yurukichi.com/meal/](https://stock.yurukichi.com/meal/)** に移転し、在庫アプリ（[home-stock-manager](https://github.com/matony3/home-stock-manager)）の一部になりました。今後の開発は home-stock-manager の `meal/` で行います。

## このリポジトリに残しているもの

GitHub Pages（`https://matony3.github.io/kondate/`）は、以前のURLを開いた人のための**移動ページ**だけになっています。

- `index.html`：移動ページ
  - その端末に以前のデータがあれば「データを持って新しい場所へ移動」で引き継げます（URL の `#import=` で渡します。APIキーは渡しません）
  - データが大きすぎるときはバックアップファイル（JSON）を書き出します
  - データがなければ、そのまま新しい場所へ移動します
- `sw.js`：以前のオフライン用キャッシュを消して登録を外すためのサービスワーカー（古い画面が出続けないようにするため、同じ場所に残しています）
- `manifest.webmanifest`・`icons/`：ホーム画面に追加していた端末向け

以前のアプリ本体（画面・献立ロジック・テスト・使わなかった Firebase 同期）は削除しました。必要なときは Git の履歴（移動ページに切り替えた時点の `bb9b6a8` など）から参照できます。

## 公開

`main` にマージすると GitHub Actions で GitHub Pages に公開されます（`.github/workflows/pages.yml`）。
