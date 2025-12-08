# Pinterval

Pinterestの画像を指定間隔で連続表示するシンプルなWebアプリです。  
左（設定）/ 中央（ビューワ）/ 右（カウントダウン＆履歴）の3カラム構成。  
状態は **スタンバイ** と **プレイ** の2つ。

## 主な機能

- 「テーマ」テキスト（Pinterest検索ワード）
- 「表示間隔」プルダウン（10/15/20/30/40/50/60/90/120/180秒）
- 「表示回数カウンター」自動加算（ユーザー操作不可）
- ビューワ中央下部に **再生/一時停止**・**停止**・**次へ** ボタン（YouTube風のUI、ビューワにホバー時のみ不透明）
- 右カラムに残り時間のカウントダウンと履歴サムネイル
- ステート管理：
  - スタンバイ：初期状態。左カラムの操作可。
  - プレイ：画像を連続表示。左カラムは操作不可（自動でdisable）。

## 動作要件

- Node.js 18+（`fetch`が使える）
- ネットワークに接続でき、Pinterestのパブリックエンドポイントへ到達できること。
  - もし到達できない場合は、モックデータ（`public/mock/sample.json`）で動作確認が可能です。

## セットアップ

```bash
# 依存関係のインストール
npm install

# 開発起動（http://localhost:5173）
npm run dev

# 本番起動（http://localhost:3000）
npm run start
```

- `USE_MOCK=1` を指定すると、Pinterest検索の代わりにモックデータを返します。

```bash
USE_MOCK=1 npm run start
```

## アーキテクチャ概要

- `public/` フロント：
  - `eventBus.js` … 開発方針に基づくイベントバス（phase/priority/lock/Abort）
  - `app.js` … UIと状態遷移（スタンバイ/プレイ）、カウントダウン、履歴など
  - `styles.css` … 3カラムレイアウトとプレイヤー風UI
- `server/` サーバ：
  - `index.js` … Express。`/api/search?q=...` でPinterest検索をプロキシ
    - まず `https://widgets.pinterest.com/v3/pidgets/search/pins` を試行
    - 失敗したらフォールバック（簡易HTML解析）→ なおダメならモックへ

## 注意事項

- 本実装はPinterestの**公開ページ**を対象にしています。Pinterestの利用規約やロボッツ、CORS等により取得できない場合があります。
- 商用利用や大規模利用を行う場合はPinterestの公式APIの利用と規約順守をご検討ください。
- 画像の著作権は各権利者に帰属します。本アプリは閲覧目的のみで利用してください。

## ライセンス

MIT
