# Web Spatial Audio Starter

スマホのブラウザだけで動く最小スターターです。HRTF 3D定位、停止トリガー、GPS、ヘッドトラッキング、（任意）地図表示を含みます。

## ファイル構成
- `index.html` … UI／Leaflet読み込み
- `style.css` … 簡易スタイル
- `app.js` … ロジック本体
- `data/points.json` … サウンドポイントの設定（lat/lon, 半径, 音源パス）
- `assets/audio/*.wav` … サンプル音源（差し替えてください）

## 使い方
1. どこかのHTTPSサーバでホスト（例：`npx serve` など）。iOSはHTTPS必須。
2. スマホで `index.html` を開き、「Start」をタップしてモーション許可を与える。
3. `data/points.json` の座標と半径、音源パスを会場に合わせて編集。

## 調整ポイント
- 静止判定: `STILL_WINDOW_MS`, `STILL_THRESH`
- ロード範囲: `LOAD_RADIUS_M`
- フェード: `FADE_SEC`
