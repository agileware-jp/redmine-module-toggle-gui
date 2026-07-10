# Redmine Module Toggler

Redmine のアクティブな全プロジェクトに対して、指定したモジュールを一括で **ON / OFF** するデスクトップ GUI アプリ。
**Electron 製**のため単一コードベースで動作し、Windows 向けの `.exe` を配布できるほか、開発・ビルドは macOS でも行える。

## 機能

1. Redmine サイト URL と REST API キーを入力して接続
2. 現在いずれかのプロジェクトで使用中のモジュール一覧を取得し、対象を複数選択（チェックボックス）
   - 一覧は「実際に使用中のモジュールのみ」を表示（実在が保証されたものだけ＝案B）
3. 確認のうえ、アクティブな全プロジェクトに対して選択モジュールを **ON** または **OFF**
   - 既存のモジュール設定は保持し、選択分だけを ON（和集合）/ OFF（差集合）
   - 差分が無いプロジェクトは PUT せずスキップ

## 技術構成・対応プラットフォーム

- **Electron 製のクロスプラットフォーム構成**。UI（HTML/CSS/JS）とロジック（`redmine.js`）は単一コードベースで、OS ごとにコードを分ける必要はない。
- **Windows**: `.exe`（ポータブル版・インストーラ）を配布。実行環境（Node/Chromium）を同梱するため、利用者は Node.js のインストール不要。
- **macOS**: 開発時は `npm start` でそのまま起動して動作確認できる。配布用の macOS アプリ（`.app`/`.dmg`）も Electron の仕組みで生成可能（後述）。
- **ビルドはクロスビルドせず、各 OS 上でネイティブに実施**する方針（Windows の `.exe` は Windows 実機/VM 上で、macOS アプリは macOS 上でビルド）。

## TLS / 証明書対応

接続画面の「TLS / 証明書設定（任意）」で、特殊な証明書要件のサイトに対応できる。通常の HTTPS（公的CA）では設定不要。

- **クライアント証明書必須（相互TLS / mTLS）**: `.p12`/`.pfx` ファイルとパスフレーズを指定すると、その証明書を提示して接続する。
- **自己署名 / 社内CA**: 社内CA証明書（`.pem`/`.crt`）を指定して信頼に追加。緊急回避として「サーバ証明書の検証をスキップ」も用意（非推奨）。
- 実装は undici の `Agent`（dispatcher）で全リクエストに適用（`redmine.js` の `buildDispatcher`）。
- パスフレーズは画面に入力後メインプロセスで使用し、ファイルには保存しない。検証スキップはその接続のみに限定（全体無効化はしない）。

## 大量プロジェクト / 通信エラーへの対応

- **ページング**: プロジェクト一覧は 100 件ずつ取得（件数制限なし）。
- **タイムアウト**: 各リクエスト 30 秒（`AbortSignal.timeout`）。ハングしたソケットを早期に打ち切る。
- **リトライ**: 各リクエスト最大 3 回。対象は「通信エラー / タイムアウト / `429` / `5xx`」のみ。`401`/`403`/`404` 等の `4xx` はリトライしない。
- **バックオフ**: 指数バックオフ＋ジッタ。`429` は `Retry-After` ヘッダを尊重。
- **PUT 間隔**: 既定 500ms スリープでサーバ負荷を抑制。リトライ発生は実行ログに表示。
- 既定値は `redmine.js` の `DEFAULT_TIMEOUT_MS` / `DEFAULT_RETRIES` / `DEFAULT_DELAY_MS` で調整可能。

> 現状は「全プロジェクト」対象。特定プロジェクト指定は拡張予定（`redmine.js` / `main.js` は `mode` 対応済みの構造）。

## 開発（Mac でも動作確認可能）

```sh
npm install
npm start
```

Electron は Mac でも起動するので、UI とロジックの確認は Mac 上でできる。

## テスト

ロジック層（`redmine.js`）の自動ユニットテストを `node:test`（Node 標準）で用意している。実ネットワーク・実 Redmine・Electron は不要で、HTTP は `undici` の `MockAgent` でモックする。

```sh
npm test
```

- 対象: URL 正規化、ON/OFF のモジュール差分計算、ページング、リトライ（`429`/`Retry-After`・`4xx` 非リトライ）、`runToggle` の更新/スキップ判定と PUT 本文、証明書 dispatcher 生成など。
- **Node.js 22 以上が必要**（`undici` 8 系が Node 22.10+ の API に依存するため）。
- push / PR 時に GitHub Actions（`.github/workflows/ci.yml`）でも自動実行される。

## Windows 用 .exe のビルド

クロスビルドは行わず、**Windows 上でネイティブにビルド**する（実機・VM どちらでも可）。

1. Windows に **Node.js LTS** をインストール（https://nodejs.org/）
2. このリポジトリを Windows ローカルにクローン／コピー（例: `C:\dev\redmine-module-toggle-gui`）
   - ※ macOS + Parallels 等で使う場合、共有フォルダ上で直接 install/build しない（遅い・ファイルロック・長いパス問題が出やすい）。Windows ローカルにコピーする。
   - ※ 他OSで作った `node_modules` は持ち込まない（Electron バイナリは OS 固有。Windows で `npm install` し直す）
3. Windows のコマンドプロンプト / PowerShell で:

```bat
cd C:\dev\redmine-module-toggle-gui
npm install
npm run build:win
```

4. `dist\` に成果物が出力される
   - `RedmineModuleToggle Setup x.y.z.exe` … インストーラ（NSIS）
   - `RedmineModuleToggle x.y.z.exe` … ポータブル版（インストール不要・単一 exe）

`package.json` の `build.win.target` で `nsis` / `portable` を切り替え可能。

## macOS 用アプリのビルド（任意）

配布用の macOS アプリも同じコードベースから生成できる。macOS 上で次のように行う（クロスビルドはしない）。

1. `package.json` の `build` に mac ターゲットを追加（例）:

   ```json
   "mac": { "target": ["dmg", "zip"] }
   ```

2. ビルド用スクリプトを追加（例: `"build:mac": "electron-builder --mac"`）し、macOS 上で実行:

   ```sh
   npm install
   npm run build:mac
   ```

3. `dist/` に `.dmg` / `.app` が出力される。

> 署名・公証（notarization）なしの場合、macOS の Gatekeeper により初回起動時に警告が出る（右クリック →「開く」等で回避可能）。

## 注意

- API キーはアプリ内（メインプロセス）でのみ使用し、画面側には保持しない。
- 操作対象は `status=1`（アクティブ）の全プロジェクト。実行前に確認ダイアログが出る。
