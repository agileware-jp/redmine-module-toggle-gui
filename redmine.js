/**
 * redmine.js
 *
 * Redmine REST API を叩くコアロジック。CLI 版 index.js のロジックを GUI 用に再構成したもの。
 * Electron のメインプロセス (Node 18+) で動作し、グローバル fetch を使う (node-fetch 不要)。
 *
 * 提供するもの:
 *   - MODULE_LABELS : module名 -> 日本語表示名 の対応表
 *   - fetchModuleSummary(url, apiKey) : 全アクティブプロジェクトを取得し、
 *       使用中モジュールの一覧 (重複排除) とプロジェクト件数を返す
 *   - runToggle({ url, apiKey, modules, mode, dryRun, delayMs, onLog }) :
 *       指定モジュールを全アクティブプロジェクトに対して ON/OFF する (マージ動作)
 */

'use strict';

const fs = require('fs');
// グローバル fetch ではなく undici 自身の fetch を使う。
// クライアント証明書等で渡す dispatcher(Agent) は同じ undici インスタンス由来でないと
// Node 内蔵 fetch では UND_ERR_INVALID_ARG で弾かれるため、fetch も undici から取得する。
const { Agent, fetch: undiciFetch } = require('undici');

const DEFAULT_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30000; // 各リクエストのタイムアウト
const DEFAULT_RETRIES = 3; // 初回失敗後の最大リトライ回数
const RETRY_BASE_MS = 1000; // 指数バックオフの基準値
const RETRY_MAX_WAIT_MS = 30000; // 1回あたりの最大待機

/** module名 -> 日本語表示名 (Lychee Redmine のモジュール一覧より) */
const MODULE_LABELS = {
  issue_tracking: 'チケットトラッキング',
  time_tracking: '時間管理',
  news: 'ニュース',
  documents: '文書',
  files: 'ファイル',
  wiki: 'Wiki',
  repository: 'リポジトリ',
  boards: 'フォーラム',
  calendar: 'カレンダー',
  gantt: 'ガントチャート',
  lac: 'Lycheeチケット関連図',
  lychee_evm: 'Lychee EVM',
  lrm: 'Lychee工数リソース管理（リソースマネジメント）',
  lychee_neo_backlog: 'Lycheeアジャイル（Neoバックログ/カンバン）',
  lychee_ccpm: 'Lychee CCPM',
  lychee_cost: 'Lycheeコストマネジメント',
  lychee_custom_field: 'Lycheeカスタムフィールド',
  lychee_gantt: 'Lycheeスケジュール管理（ガントチャート5）',
  lychee_issue_set: 'Lycheeスケジュール管理（チケットセット）',
  lychee_agile: 'Lycheeスケジュール管理（カンバン）',
  lychee_backlog: 'Lycheeスケジュール管理（バックログ）',
  lychee_project_dashboard: 'Lycheeダッシュボード',
  lychee_project_report: 'Lycheeプロジェクトレポート',
  lychee_time_management: 'Lychee工数リソース管理（タイムマネジメント）',
  banner: 'バナー',
  issue_templates: 'チケットテンプレート',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TLS 設定から undici Agent (dispatcher) を生成する。設定が無ければ undefined。
 * @param {object} [tls]
 * @param {string} [tls.pfxPath]    クライアント証明書 (.p12/.pfx) のパス
 * @param {string} [tls.passphrase] 上記のパスフレーズ
 * @param {string} [tls.caPath]     追加で信頼する CA 証明書 (.pem/.crt) のパス
 * @param {boolean}[tls.insecure]   サーバ証明書の検証をスキップ (自己署名向け・非推奨)
 */
function buildDispatcher(tls) {
  if (!tls) return undefined;
  const connect = {};
  let used = false;

  if (tls.pfxPath) {
    try {
      connect.pfx = fs.readFileSync(tls.pfxPath);
    } catch (e) {
      throw new Error(`クライアント証明書を読み込めません (${tls.pfxPath}): ${e.message}`);
    }
    if (tls.passphrase) connect.passphrase = tls.passphrase;
    used = true;
  }
  if (tls.caPath) {
    try {
      connect.ca = fs.readFileSync(tls.caPath);
    } catch (e) {
      throw new Error(`CA 証明書を読み込めません (${tls.caPath}): ${e.message}`);
    }
    used = true;
  }
  if (tls.insecure) {
    connect.rejectUnauthorized = false;
    used = true;
  }

  return used ? new Agent({ connect }) : undefined;
}

/** リトライ対象の HTTP ステータスか (429: レート制限 / 5xx: サーバ側一時障害) */
function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** 指数バックオフ + ジッタ (attempt: 0,1,2,... → 1s,2s,4s,... を上限でクランプ) */
function backoffMs(attempt) {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = base * 0.2 * Math.random();
  return Math.min(base + jitter, RETRY_MAX_WAIT_MS);
}

/** 429 の Retry-After ヘッダ (秒数 or HTTP-date) を ms に変換。無ければ null */
function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * fetch にタイムアウトとリトライを付与したラッパ。
 * - 各試行に timeoutMs のタイムアウト (AbortSignal.timeout)
 * - 通信エラー / タイムアウト / 429 / 5xx のときのみ最大 retries 回リトライ
 * - 4xx (429 を除く) はリトライせずそのまま返す (認証エラー等で無駄打ちしない)
 */
async function fetchWithRetry(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, onLog, dispatcher } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  let attempt = 0;
  while (true) {
    try {
      const fetchOpts = { ...options, signal: AbortSignal.timeout(timeoutMs) };
      if (dispatcher) fetchOpts.dispatcher = dispatcher;
      const res = await undiciFetch(url, fetchOpts);
      if (isRetriableStatus(res.status) && attempt < retries) {
        const wait = retryAfterMs(res) ?? backoffMs(attempt);
        attempt++;
        log(`  リトライ ${attempt}/${retries}: HTTP ${res.status} のため ${Math.round(wait)}ms 待機`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      // AbortSignal.timeout は TimeoutError、その他は通信エラー
      if (attempt < retries) {
        const wait = backoffMs(attempt);
        attempt++;
        const reason = e && e.name === 'TimeoutError' ? `タイムアウト(${timeoutMs}ms)` : `通信エラー(${e && e.message})`;
        log(`  リトライ ${attempt}/${retries}: ${reason} のため ${Math.round(wait)}ms 待機`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

/**
 * ベースURLに正規化する。
 * - 末尾スラッシュを除去
 * - 貼り付けミス対策: アプリ内ルート (/projects/... や /issues 等) が付いていたら
 *   ベースURLまで切り詰める。サブパス設置 (例: http://host/redmine) は保持される。
 */
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Redmine URL が指定されていません。');
  }
  let u = rawUrl.trim();
  u = u.replace(
    /\/(projects|issues|my|activity|time_entries|admin|news|boards|documents|wiki|roadmap|gantt|calendar)(\/.*)?$/i,
    ''
  );
  return u.replace(/\/+$/, '');
}

function buildHeaders(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('API キーが指定されていません。');
  }
  return {
    'Content-Type': 'application/json',
    'X-Redmine-API-Key': apiKey.trim(),
  };
}

/**
 * アクティブな全プロジェクト (status=1) を enabled_modules 付きで取得。
 * total_count に達するまでページングする (件数制限なし)。各ページはタイムアウト+リトライ付き。
 */
async function getActiveProjects(redmineUrl, headers, opts = {}) {
  const limit = 100;
  const all = [];
  let offset = 0;
  let totalCount = null;

  while (true) {
    const url = `${redmineUrl}/projects.json?status=1&include=enabled_modules&limit=${limit}&offset=${offset}`;
    const res = await fetchWithRetry(url, { headers }, opts);
    if (!res.ok) {
      throw new Error(`プロジェクト取得に失敗しました (offset=${offset}): ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    const page = Array.isArray(json.projects) ? json.projects : [];
    if (totalCount === null) totalCount = json.total_count;
    all.push(...page);
    if (page.length === 0) break;
    if (all.length >= totalCount) break;
    offset += page.length;
  }

  return { projects: all, total_count: totalCount ?? all.length };
}

async function updateProject(redmineUrl, headers, identifier, names, opts = {}) {
  const res = await fetchWithRetry(
    `${redmineUrl}/projects/${encodeURIComponent(identifier)}.json`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({ project: { enabled_module_names: names } }),
    },
    opts
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${body}`.trim());
  }
}

/** ON: before ∪ targets / OFF: before − targets */
function computeAfter(before, targets, mode) {
  if (mode === 'on') {
    const merged = new Set(before);
    for (const m of targets) merged.add(m);
    return [...merged];
  }
  const targetSet = new Set(targets);
  return before.filter((m) => !targetSet.has(m));
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/**
 * 接続テスト兼モジュール一覧取得 (案B)。
 * 全アクティブプロジェクトを取得し、いずれかのプロジェクトで実際に使用されている
 * モジュールのみを返す (未使用モジュールは含めない = 実在が保証されたものだけ)。
 * @returns {{ projectCount:number, modules: Array<{name:string,label:string,inUse:number}> }}
 */
async function fetchModuleSummary(url, apiKey, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, tls } = {}) {
  const redmineUrl = normalizeUrl(url);
  const headers = buildHeaders(apiKey);
  const dispatcher = buildDispatcher(tls);
  const { projects, total_count } = await getActiveProjects(redmineUrl, headers, { timeoutMs, retries, dispatcher });

  // 各モジュールが何プロジェクトで使われているかを集計
  const counts = new Map();
  for (const project of projects) {
    const names = Array.isArray(project.enabled_modules)
      ? project.enabled_modules.map((m) => m.name)
      : [];
    for (const name of names) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  // 案B: 実際にいずれかのプロジェクトで使用中のモジュールのみを一覧化する。
  // 表示名は MODULE_LABELS にあれば日本語名、無ければ module名そのまま。
  const modules = [...counts.entries()]
    .map(([name, inUse]) => ({ name, label: MODULE_LABELS[name] || name, inUse }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ja'));

  return { projectCount: total_count, modules };
}

/**
 * 指定モジュールを全アクティブプロジェクトに対して ON/OFF する。
 * @param {object} opts
 * @param {string} opts.url      Redmine URL
 * @param {string} opts.apiKey   REST API キー
 * @param {string[]} opts.modules 対象 module名
 * @param {'on'|'off'} [opts.mode='off']
 * @param {boolean} [opts.dryRun=false] 真なら PUT を発行せず差分のみ算出
 * @param {number} [opts.delayMs=500]  PUT 間スリープ(ms)
 * @param {number} [opts.timeoutMs=30000] 各リクエストのタイムアウト(ms)
 * @param {number} [opts.retries=3] 各リクエストの最大リトライ回数
 * @param {object} [opts.tls] TLS/証明書設定 (buildDispatcher 参照)
 * @param {(line:string)=>void} [opts.onLog] 進捗ログコールバック
 * @returns {Promise<{updated:number,skipped:number,failed:number,total:number,dryRun:boolean}>}
 */
async function runToggle({ url, apiKey, modules, mode = 'off', dryRun = false, delayMs = DEFAULT_DELAY_MS, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, tls, onLog }) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const redmineUrl = normalizeUrl(url);
  const headers = buildHeaders(apiKey);
  const dispatcher = buildDispatcher(tls);
  const reqOpts = { timeoutMs, retries, onLog: log, dispatcher };

  const targets = [...new Set(modules || [])];
  if (targets.length === 0) {
    throw new Error('対象モジュールが1つも選択されていません。');
  }
  if (mode !== 'on' && mode !== 'off') {
    throw new Error(`mode は 'on' または 'off' を指定してください (受け取った値: '${mode}')。`);
  }

  const { projects } = await getActiveProjects(redmineUrl, headers, reqOpts);

  log(
    dryRun
      ? `[DRY-RUN] ${projects.length} 件のプロジェクトを確認します: mode=${mode}, modules=[${targets.join(', ')}]`
      : `${projects.length} 件のプロジェクトを更新します: mode=${mode}, modules=[${targets.join(', ')}], delay=${delayMs}ms, timeout=${timeoutMs}ms, retries=${retries}`
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let didFirstPut = false;

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    const before = Array.isArray(project.enabled_modules) ? project.enabled_modules.map((m) => m.name) : [];
    const after = computeAfter(before, targets, mode);
    const noDiff = sameSet(before, after);

    const prefix = `[${i + 1}/${projects.length}] id=${project.id} ${project.identifier}`;
    const beforeStr = `before=[${before.join(', ')}]`;
    const afterStr = `after=[${after.join(', ')}]`;

    if (noDiff) {
      log(`${prefix} ${beforeStr} ${afterStr} (SKIP: 差分なし)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      log(`${prefix} ${beforeStr} ${afterStr} [DRY-RUN]`);
      continue;
    }

    if (didFirstPut && delayMs > 0) await sleep(delayMs);
    didFirstPut = true;

    try {
      await updateProject(redmineUrl, headers, project.identifier, after, reqOpts);
      log(`${prefix} ${beforeStr} ${afterStr} (更新)`);
      updated++;
    } catch (e) {
      log(`${prefix} ${beforeStr} ${afterStr} (失敗: ${e.message})`);
      failed++;
    }
  }

  log(`完了${dryRun ? ' (dry-run)' : ''}. updated=${updated} skipped=${skipped} failed=${failed} total=${projects.length}`);
  return { updated, skipped, failed, total: projects.length, dryRun };
}

module.exports = {
  MODULE_LABELS,
  fetchModuleSummary,
  runToggle,
  // 以下はテスト用に公開している内部関数
  normalizeUrl,
  computeAfter,
  sameSet,
  buildDispatcher,
};
