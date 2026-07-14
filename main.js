'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { fetchModuleSummary, runToggle } = require('./redmine');

function createWindow() {
  const win = new BrowserWindow({
    width: 860,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 証明書ファイルの選択ダイアログ (kind: 'pfx' | 'ca')
ipcMain.handle('pick-file', async (_event, kind) => {
  const filters =
    kind === 'ca'
      ? [{ name: 'CA証明書', extensions: ['pem', 'crt', 'cer'] }, { name: 'すべて', extensions: ['*'] }]
      : [{ name: 'クライアント証明書', extensions: ['p12', 'pfx'] }, { name: 'すべて', extensions: ['*'] }];
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// 接続テスト兼モジュール一覧取得
ipcMain.handle('fetch-modules', async (_event, { url, apiKey, tls }) => {
  return await fetchModuleSummary(url, apiKey, { tls });
});

// モジュールの ON/OFF 実行 (UI の ON/OFF ボタンから mode='on'|'off' で呼ばれる)
ipcMain.handle('toggle', async (event, { url, apiKey, modules, mode, dryRun, tls }) => {
  return await runToggle({
    url,
    apiKey,
    modules,
    mode: mode || 'off',
    dryRun: !!dryRun,
    tls,
    onLog: (line) => event.sender.send('toggle-progress', line),
  });
});
