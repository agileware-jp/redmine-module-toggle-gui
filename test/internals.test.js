'use strict';

// テスト詳細設計 (test_detailed_design) C-01〜C-29 のうち、
// redmine.test.js で未カバーだったケースを補完するテスト群。

const { test } = require('node:test');
const assert = require('node:assert');
const { MockAgent, setGlobalDispatcher } = require('undici');

const {
  normalizeUrl,
  buildHeaders,
  isRetriableStatus,
  backoffMs,
  retryAfterMs,
  describeNetworkError,
  fetchModuleSummary,
  runToggle,
} = require('../redmine.js');

const BASE = 'http://redmine.example';
const PROJECTS = /^\/projects\.json/;

function mockPool() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get(BASE);
}

function makeProjects(n, moduleName = 'wiki', offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: offset + i + 1,
    identifier: `p${offset + i + 1}`,
    enabled_modules: [{ name: moduleName }],
  }));
}

// ============================================================
// C-01/C-02/C-05: normalizeUrl 追加ケース
// ============================================================

test('C-02 normalizeUrl: 前後空白は trim、IPv6/IP/ポート表記は保持', () => {
  assert.equal(normalizeUrl('  https://x.example.com  '), 'https://x.example.com');
  assert.equal(normalizeUrl('http://[::1]:3000/'), 'http://[::1]:3000');
  assert.equal(normalizeUrl('http://192.168.1.10:3000'), 'http://192.168.1.10:3000');
});

test('C-05 normalizeUrl: http(s) 以外のスキーム・ただの文字列は明示エラー', () => {
  assert.throws(() => normalizeUrl('ftp://x.example.com'), /http/);
  assert.throws(() => normalizeUrl('ただの文字列'), /http/);
  assert.throws(() => normalizeUrl('redmine.example.com'), /http/);
});

test('C-04 入力長境界: 10,000文字級の URL/キーでも例外なく処理', () => {
  const longUrl = 'https://x.example.com/' + 'a'.repeat(10000);
  assert.ok(typeof normalizeUrl(longUrl) === 'string');
  const h = buildHeaders('k'.repeat(10000));
  assert.equal(h['X-Redmine-API-Key'].length, 10000);
});

// ============================================================
// C-03: buildHeaders
// ============================================================

test('C-03 buildHeaders: 空/空白のみは throw、有効値は trim して設定', () => {
  assert.throws(() => buildHeaders(''), /API キー/);
  assert.throws(() => buildHeaders('   '), /API キー/);
  assert.throws(() => buildHeaders(null), /API キー/);
  const h = buildHeaders('  secret  ');
  assert.equal(h['X-Redmine-API-Key'], 'secret');
  assert.equal(h['Content-Type'], 'application/json');
});

// ============================================================
// C-11/C-12/C-13: リトライ規約の内部関数
// ============================================================

test('C-11 isRetriableStatus: 429 と 5xx のみ true', () => {
  for (const s of [200, 204, 301, 400, 401, 403, 404, 409, 422, 428]) {
    assert.equal(isRetriableStatus(s), false, `status ${s}`);
  }
  for (const s of [429, 500, 502, 503, 504, 599]) {
    assert.equal(isRetriableStatus(s), true, `status ${s}`);
  }
});

test('C-12 retryAfterMs: 秒数/HTTP-date/不正値の変換', () => {
  const res = (v) => ({ headers: new Map(v === undefined ? [] : [['retry-after', v]]) });
  assert.equal(retryAfterMs(res('0')), 0);
  assert.equal(retryAfterMs(res('120')), 120000);
  assert.equal(retryAfterMs(res('abc')), null);
  assert.equal(retryAfterMs(res(undefined)), null);
  // HTTP-date (未来60秒) → 残り ms (誤差許容)
  const future = retryAfterMs(res(new Date(Date.now() + 60000).toUTCString()));
  assert.ok(future > 50000 && future <= 61000, `future=${future}`);
  // HTTP-date (過去) → 0
  assert.equal(retryAfterMs(res(new Date(Date.now() - 60000).toUTCString())), 0);
});

test('C-13 backoffMs: 指数増加 + ジッタ(20%以内) + 30秒クランプ', () => {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const base = 1000 * Math.pow(2, attempt);
    const v = backoffMs(attempt);
    assert.ok(v >= base && v <= base * 1.2, `attempt=${attempt} v=${v}`);
  }
  // base が 30 秒を超える attempt はクランプされる
  assert.equal(backoffMs(5), 30000);
  assert.equal(backoffMs(10), 30000);
});

// ============================================================
// エラー分類 (C-32 改善 / 懸念E)
// ============================================================

test('describeNetworkError: cause コード別に日本語メッセージへ分類', () => {
  const e = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  assert.match(describeNetworkError(e('ENOTFOUND'), 30000), /ホスト名を解決できません/);
  assert.match(describeNetworkError(e('ECONNREFUSED'), 30000), /接続が拒否されました/);
  assert.match(describeNetworkError(e('SELF_SIGNED_CERT_IN_CHAIN'), 30000), /証明書を検証できません/);
  assert.match(describeNetworkError(e('CERT_HAS_EXPIRED'), 30000), /有効期限/);
  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  assert.match(describeNetworkError(timeout, 1234), /タイムアウト: 1234ms/);
  // 分類不能は null (元エラーを使う)
  assert.equal(describeNetworkError(e('SOMETHING_ELSE'), 30000), null);
  assert.equal(describeNetworkError(new Error('plain'), 30000), null);
});

// ============================================================
// C-18/C-19: ページネーション境界・途中失敗
// ============================================================

test('C-18 ページング: 0件は1リクエストで空結果', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, { total_count: 0, projects: [] });
  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 0);
  assert.deepEqual(r.modules, []);
});

test('C-18 ページング: ちょうど100件は追加リクエストを発行しない', async () => {
  const pool = mockPool();
  // offset=0 のみ許可 (2回目のリクエストが出ればマッチせず失敗する)
  pool
    .intercept({ path: /offset=0/, method: 'GET' })
    .reply(200, { total_count: 100, projects: makeProjects(100) });
  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 100);
  assert.equal(r.modules.find((m) => m.name === 'wiki').inUse, 100);
});

test('C-18 ページング: 101件は2ページで全件取得(欠落・重複なし)', async () => {
  const pool = mockPool();
  pool
    .intercept({ path: /offset=0/, method: 'GET' })
    .reply(200, { total_count: 101, projects: makeProjects(100) });
  pool
    .intercept({ path: /offset=100/, method: 'GET' })
    .reply(200, { total_count: 101, projects: makeProjects(1, 'wiki', 100) });
  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 101);
  assert.equal(r.modules.find((m) => m.name === 'wiki').inUse, 101);
});

test('C-18/D-07 ページング: total_count 欠落でも空ページ到達で終了する', async () => {
  const pool = mockPool();
  pool.intercept({ path: /offset=0/, method: 'GET' }).reply(200, { projects: makeProjects(100) });
  pool.intercept({ path: /offset=100/, method: 'GET' }).reply(200, { projects: [] });
  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 100);
});

test('C-19 ページング途中の失敗: 2ページ目の 503 は offset 付きで明示エラー', async () => {
  const pool = mockPool();
  pool
    .intercept({ path: /offset=0/, method: 'GET' })
    .reply(200, { total_count: 250, projects: makeProjects(100) });
  pool.intercept({ path: /offset=100/, method: 'GET' }).reply(503, '').persist();
  await assert.rejects(fetchModuleSummary(BASE, 'key', { retries: 0 }), /offset=100.*503/);
});

// ============================================================
// C-15/C-17: リトライ枯渇・タイムアウト
// ============================================================

test('C-15 リトライ枯渇: 503 継続で retries=2 → 計3回試行して失敗', async () => {
  const pool = mockPool();
  let calls = 0;
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(() => {
      calls++;
      return { statusCode: 503, data: '' };
    })
    .persist();
  await assert.rejects(fetchModuleSummary(BASE, 'key', { retries: 2 }), /503/);
  assert.equal(calls, 3);
});

test('C-17 タイムアウト: 応答遅延 > timeoutMs で分類済みエラー', async () => {
  const pool = mockPool();
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(200, { total_count: 0, projects: [] })
    .delay(500);
  await assert.rejects(
    fetchModuleSummary(BASE, 'key', { timeoutMs: 50, retries: 0 }),
    /タイムアウト/
  );
});

// ============================================================
// C-22(再実行)/C-24/C-25/C-29: runToggle
// ============================================================

test('C-22 冪等: 既に目標状態なら PUT 0件・全スキップ', async () => {
  const pool = mockPool();
  // 全プロジェクトが既に wiki 有効 → ON しても差分なし
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(200, { total_count: 2, projects: makeProjects(2) });
  // PUT の intercept は登録しない = PUT が発行されればテスト失敗する
  const r = await runToggle({ url: BASE, apiKey: 'key', modules: ['wiki'], mode: 'on', delayMs: 0, retries: 0 });
  assert.deepEqual(
    { updated: r.updated, skipped: r.skipped, failed: r.failed, total: r.total },
    { updated: 0, skipped: 2, failed: 0, total: 2 }
  );
});

test('C-24 不正 mode は明示エラーで PUT 不発', async () => {
  await assert.rejects(
    runToggle({ url: BASE, apiKey: 'key', modules: ['wiki'], mode: 'delete' }),
    /mode は 'on' または 'off'/
  );
});

test('C-25 部分失敗: 403 の1件は failed 計上・非リトライで処理は継続', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {
    total_count: 3,
    projects: makeProjects(3), // 全件 wiki 有効 → OFF で全件差分あり
  });
  let p2Calls = 0;
  let p3Called = false;
  pool.intercept({ path: '/projects/p1.json', method: 'PUT' }).reply(200, {});
  pool
    .intercept({ path: '/projects/p2.json', method: 'PUT' })
    .reply(() => {
      p2Calls++;
      return { statusCode: 403, data: 'Forbidden' };
    })
    .persist();
  pool.intercept({ path: '/projects/p3.json', method: 'PUT' }).reply(() => {
    p3Called = true;
    return { statusCode: 200, data: {} };
  });

  const lines = [];
  const r = await runToggle({
    url: BASE, apiKey: 'key', modules: ['wiki'], mode: 'off',
    delayMs: 0, retries: 3, onLog: (l) => lines.push(l),
  });
  assert.deepEqual(
    { updated: r.updated, skipped: r.skipped, failed: r.failed, total: r.total },
    { updated: 2, skipped: 0, failed: 1, total: 3 }
  );
  assert.equal(p2Calls, 1, '403 はリトライされない');
  assert.ok(p3Called, '失敗後も後続プロジェクトを処理する');
  assert.ok(lines.some((l) => l.includes('失敗') && l.includes('403')), '失敗理由がログに含まれる');
});

test('C-23 PUT間隔: 2件目以降は delayMs 待機してから発行', async () => {
  const pool = mockPool();
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(200, { total_count: 2, projects: makeProjects(2) });
  const times = [];
  for (const p of ['p1', 'p2']) {
    pool.intercept({ path: `/projects/${p}.json`, method: 'PUT' }).reply(() => {
      times.push(Date.now());
      return { statusCode: 200, data: {} };
    });
  }
  await runToggle({ url: BASE, apiKey: 'key', modules: ['wiki'], mode: 'off', delayMs: 120, retries: 0 });
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 100, `interval=${times[1] - times[0]}ms`);
});

test('C-29 機密非混入: onLog 全行に API キーが含まれない', async () => {
  const pool = mockPool();
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(200, { total_count: 1, projects: makeProjects(1) });
  pool.intercept({ path: '/projects/p1.json', method: 'PUT' }).reply(200, {});
  const lines = [];
  await runToggle({
    url: BASE, apiKey: 'super-secret-key-123', modules: ['wiki'], mode: 'off',
    delayMs: 0, retries: 0, onLog: (l) => lines.push(l),
  });
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('\n').includes('super-secret-key-123'));
});

// ============================================================
// C-27: 異常データ
// ============================================================

test('C-27 異常応答: 200 + HTML はクラッシュせず例外が伝播', async () => {
  const pool = mockPool();
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(200, '<html><body>error page</body></html>', {
      headers: { 'content-type': 'text/html' },
    });
  await assert.rejects(fetchModuleSummary(BASE, 'key', { retries: 0 }));
});

test('C-27 異常応答: projects 欠落 ({}) は空結果として扱う', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {});
  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 0);
  assert.deepEqual(r.modules, []);
});

test('C-27/D-07 異常データ: enabled_modules が null/欠落でも空扱いで続行', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {
    total_count: 3,
    projects: [
      { id: 1, identifier: 'a', enabled_modules: [{ name: 'wiki' }] },
      { id: 2, identifier: 'b', enabled_modules: null },
      { id: 3, identifier: 'c' },
    ],
  });
  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 3);
  assert.equal(r.modules.length, 1);
  assert.equal(r.modules[0].inUse, 1);
});

// ============================================================
// C-21: 未知モジュール名の表示名フォールバック
// ============================================================

test('C-21 未知モジュール名は name がそのまま label になる', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {
    total_count: 1,
    projects: [
      { id: 1, identifier: 'a', enabled_modules: [{ name: 'wiki' }, { name: 'custom_plugin_module' }] },
    ],
  });
  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  const custom = r.modules.find((m) => m.name === 'custom_plugin_module');
  assert.equal(custom.label, 'custom_plugin_module');
  assert.equal(r.modules.find((m) => m.name === 'wiki').label, 'Wiki');
});
