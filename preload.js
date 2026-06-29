'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// renderer からは window.api 経由でのみメインプロセスを呼べる。
// API キーや URL はメインプロセスに渡して処理し、renderer 側には保持しない方針。
contextBridge.exposeInMainWorld('api', {
  fetchModules: (cfg) => ipcRenderer.invoke('fetch-modules', cfg),
  toggle: (cfg) => ipcRenderer.invoke('toggle', cfg),
  pickFile: (kind) => ipcRenderer.invoke('pick-file', kind),
  onProgress: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('toggle-progress', listener);
    // 解除用の関数を返す
    return () => ipcRenderer.removeListener('toggle-progress', listener);
  },
});
