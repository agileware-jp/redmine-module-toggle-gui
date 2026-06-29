# Redmine モジュール一括設定 (GUI / Electron)

Redmine のアクティブな全プロジェクトに対して、指定したモジュールを一括で OFF にする Windows GUI アプリ。
CLI 版 `index.js` のロジック（マージ動作の ON/OFF）を Electron で GUI 化したもの。

## 機能

1. Redmine サイト URL と REST API キーを入力して接続
2. 現在いずれかのプロジェクトで使用中のモジュール一覧を取得し、対象を複数選択（チェックボックス）
   - 一覧は「実際に使用中のモジュールのみ」を表示（実在が保証されたものだけ＝案B）
3. 確認のうえ、アクティブな全プロジェクトに対して選択モジュールを **ON** または **OFF**
   - 既存のモジュール設定は保持し、選択分だけを ON（和集合）/ OFF（差集合）
   - 差分が無いプロジェクトは PUT せずスキップ

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

## 注意

- API キーはアプリ内（メインプロセス）でのみ使用し、画面側には保持しない。
- 操作対象は `status=1`（アクティブ）の全プロジェクト。実行前に確認ダイアログが出る。
