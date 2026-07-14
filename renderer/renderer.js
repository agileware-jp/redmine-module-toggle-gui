'use strict';

// ---- 状態 ----
const state = {
  url: '',
  apiKey: '',
  tls: null,
  projectCount: 0,
  modules: [], // { name, label, inUse }
};

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const urlInput = $('url');
const apiKeyInput = $('apiKey');
const btnConnect = $('btn-connect');
const connectStatus = $('connect-status');

// TLS / 証明書設定
const pfxPathInput = $('pfxPath');
const pfxPassInput = $('pfxPass');
const caPathInput = $('caPath');
const insecureInput = $('insecure');

function collectTls() {
  const tls = {
    pfxPath: pfxPathInput.value || undefined,
    passphrase: pfxPassInput.value || undefined,
    caPath: caPathInput.value || undefined,
    insecure: insecureInput.checked,
  };
  // 何も設定が無ければ null (通常HTTPS扱い)
  if (!tls.pfxPath && !tls.caPath && !tls.insecure) return null;
  return tls;
}

$('btn-pick-pfx').addEventListener('click', async () => {
  const p = await window.api.pickFile('pfx');
  if (p) pfxPathInput.value = p;
});
$('btn-clear-pfx').addEventListener('click', () => {
  pfxPathInput.value = '';
});
$('btn-pick-ca').addEventListener('click', async () => {
  const p = await window.api.pickFile('ca');
  if (p) caPathInput.value = p;
});
$('btn-clear-ca').addEventListener('click', () => {
  caPathInput.value = '';
});

const stepSelect = $('step-select');
const selectSummary = $('select-summary');
const moduleListEl = $('module-list');
const btnCheckAll = $('btn-check-all');
const btnUncheckAll = $('btn-uncheck-all');
const btnOn = $('btn-on');
const btnOff = $('btn-off');

const stepLog = $('step-log');
const logEl = $('log');
const logSummary = $('log-summary');

// ---- ヘルパ ----
function setStatus(el, message, type) {
  el.textContent = message || '';
  el.className = 'status' + (type ? ' ' + type : '');
}

function appendLog(line) {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function selectedModules() {
  return [...moduleListEl.querySelectorAll('input[type=checkbox]:checked')].map((cb) => cb.value);
}

function setBusy(busy) {
  [btnConnect, btnOn, btnOff, btnCheckAll, btnUncheckAll].forEach((b) => {
    b.disabled = busy;
  });
  // busy 解除時は選択状態に応じて ON/OFF ボタンの活性を復元する
  if (!busy) updateRunButtons();
}

// IPC 越しの例外メッセージから内部表現 ("Error invoking remote method '…': ") を除去する
function friendlyIpcError(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, '');
}

// ---- STEP 1: 接続 ----
btnConnect.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  if (!url || !apiKey) {
    setStatus(connectStatus, 'URL と API キーを入力してください。', 'error');
    return;
  }

  const tls = collectTls();
  setBusy(true);
  setStatus(connectStatus, '接続中…', 'info');
  try {
    const result = await window.api.fetchModules({ url, apiKey, tls });
    state.url = url;
    state.apiKey = apiKey;
    state.tls = tls;
    state.projectCount = result.projectCount;
    state.modules = result.modules;
    renderModuleList();
    setStatus(
      connectStatus,
      `接続成功: アクティブなプロジェクト ${result.projectCount} 件 / 使用中モジュール ${result.modules.length} 種`,
      'success'
    );
    stepSelect.classList.remove('hidden');
    stepSelect.scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    setStatus(connectStatus, '接続に失敗しました: ' + friendlyIpcError(e), 'error');
  } finally {
    setBusy(false);
  }
});

// ---- STEP 2: モジュール一覧描画 ----
function renderModuleList() {
  selectSummary.textContent = `アクティブなプロジェクト ${state.projectCount} 件で現在使用中のモジュールです。対象にチェックを入れ、ON または OFF を実行してください。（数字は現在の使用プロジェクト数）`;
  moduleListEl.innerHTML = '';
  for (const mod of state.modules) {
    // モジュール名/表示名はサーバ由来の文字列のため、innerHTML ではなく
    // createElement + textContent で挿入する (マークアップ注入対策)
    const row = document.createElement('label');
    row.className = 'module-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = mod.name;

    const label = document.createElement('span');
    label.className = 'module-label';
    label.textContent = mod.label;

    const name = document.createElement('span');
    name.className = 'module-name';
    name.textContent = mod.name;

    const count = document.createElement('span');
    count.className = 'module-count';
    count.textContent = `${mod.inUse} プロジェクト`;

    row.append(checkbox, label, name, count);
    moduleListEl.appendChild(row);
  }
  updateRunButtons();
}

// 選択0件時は ON/OFF ボタンを非活性にする (誤操作防止)
function updateRunButtons() {
  const anyChecked = !!moduleListEl.querySelector('input[type=checkbox]:checked');
  btnOn.disabled = !anyChecked;
  btnOff.disabled = !anyChecked;
}

moduleListEl.addEventListener('change', updateRunButtons);

btnCheckAll.addEventListener('click', () => {
  moduleListEl.querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.checked = true));
  updateRunButtons();
});
btnUncheckAll.addEventListener('click', () => {
  moduleListEl.querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.checked = false));
  updateRunButtons();
});

// ---- 実行共通 ----
let detachProgress = null;

async function execute(mode) {
  const modules = selectedModules();
  if (modules.length === 0) {
    alert('対象モジュールを1つ以上選択してください。');
    return;
  }

  const modeLabel = mode === 'on' ? 'ON' : 'OFF';
  const labels = state.modules
    .filter((m) => modules.includes(m.name))
    .map((m) => `・${m.label} (${m.name})`)
    .join('\n');
  const ok = confirm(
    `アクティブな全プロジェクト（${state.projectCount} 件）に対して、以下のモジュールを ${modeLabel} にします。\n\n${labels}\n\nこの操作は各プロジェクトの設定を変更します。実行しますか？`
  );
  if (!ok) return;

  stepLog.classList.remove('hidden');
  logEl.textContent = '';
  setStatus(logSummary, `${modeLabel} を実行中…`, 'info');
  stepLog.scrollIntoView({ behavior: 'smooth' });

  // 進捗購読
  if (detachProgress) detachProgress();
  detachProgress = window.api.onProgress(appendLog);

  setBusy(true);
  try {
    const summary = await window.api.toggle({
      url: state.url,
      apiKey: state.apiKey,
      tls: state.tls,
      modules,
      mode,
      dryRun: false,
    });
    setStatus(
      logSummary,
      `[${modeLabel}] 完了: 更新 ${summary.updated} / スキップ ${summary.skipped} / 失敗 ${summary.failed} / 合計 ${summary.total}`,
      summary.failed > 0 ? 'error' : 'success'
    );
  } catch (e) {
    appendLog('エラー: ' + friendlyIpcError(e));
    setStatus(logSummary, '実行に失敗しました: ' + friendlyIpcError(e), 'error');
  } finally {
    setBusy(false);
    if (detachProgress) {
      detachProgress();
      detachProgress = null;
    }
  }
}

btnOn.addEventListener('click', () => execute('on'));
btnOff.addEventListener('click', () => execute('off'));
