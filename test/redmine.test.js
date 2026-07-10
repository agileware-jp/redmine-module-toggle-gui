'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { MockAgent, setGlobalDispatcher, Agent } = require('undici');

const {
  normalizeUrl,
  computeAfter,
  sameSet,
  buildDispatcher,
  fetchModuleSummary,
  runToggle,
} = require('../redmine.js');

// ============================================================
// 純粋関数
// ============================================================

test('normalizeUrl: 末尾スラッシュを除去', () => {
  assert.equal(normalizeUrl('http://h:13000/'), 'http://h:13000');
  assert.equal(normalizeUrl('http://h:13000'), 'http://h:13000');
  assert.equal(normalizeUrl('  http://h:13000//  '), 'http://h:13000');
});

test('normalizeUrl: アプリ内ルートを除去しサブパスは保持', () => {
  assert.equal(normalizeUrl('http://h/6.1/projects/test/issues'), 'http://h/6.1');
  assert.equal(normalizeUrl('http://h/redmine/projects'), 'http://h/redmine');
  assert.equal(normalizeUrl('http://h/projects/test/issues'), 'http://h');
});

test('normalizeUrl: 空・非文字列はエラー', () => {
  assert.throws(() => normalizeUrl(''));
  assert.throws(() => normalizeUrl(null));
  assert.throws(() => normalizeUrl(undefined));
});

test('computeAfter: on は和集合(重複排除)', () => {
  assert.deepEqual(computeAfter(['a', 'b'], ['b', 'c'], 'on').sort(), ['a', 'b', 'c']);
  assert.deepEqual(computeAfter([], ['x'], 'on'), ['x']);
});

test('computeAfter: off は差集合', () => {
  assert.deepEqual(computeAfter(['a', 'b', 'c'], ['b'], 'off'), ['a', 'c']);
  assert.deepEqual(computeAfter(['a'], ['x'], 'off'), ['a']); // 対象が無ければ不変
});

test('sameSet: 順不同で等価判定', () => {
  assert.ok(sameSet(['a', 'b'], ['b', 'a']));
  assert.ok(sameSet([], []));
  assert.ok(!sameSet(['a'], ['a', 'b']));
  assert.ok(!sameSet(['a', 'b'], ['a', 'c']));
});

test('buildDispatcher: 設定無しは undefined', () => {
  assert.equal(buildDispatcher(null), undefined);
  assert.equal(buildDispatcher({}), undefined);
});

test('buildDispatcher: insecure は Agent を返す', () => {
  assert.ok(buildDispatcher({ insecure: true }) instanceof Agent);
});

test('buildDispatcher: 不正な証明書パスは分かりやすいエラー', () => {
  assert.throws(() => buildDispatcher({ pfxPath: '/no/such/file.p12' }), /読み込めません/);
});

// ============================================================
// HTTP (undici MockAgent で実ネットワーク無しに検証)
// ============================================================

const BASE = 'http://redmine.example';
const PROJECTS = /^\/projects\.json/;

function mockPool() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get(BASE);
}

test('fetchModuleSummary: 使用中モジュールを集計(表示名付き)', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {
    total_count: 2,
    projects: [
      { id: 1, identifier: 'a', enabled_modules: [{ name: 'wiki' }, { name: 'news' }] },
      { id: 2, identifier: 'b', enabled_modules: [{ name: 'wiki' }] },
    ],
  });

  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 2);
  assert.equal(r.modules.length, 2);
  const wiki = r.modules.find((m) => m.name === 'wiki');
  assert.equal(wiki.inUse, 2);
  assert.equal(wiki.label, 'Wiki');
});

test('fetchModuleSummary: total_count に達するまでページング', async () => {
  const pool = mockPool();
  pool.intercept({ path: /offset=0/, method: 'GET' }).reply(200, {
    total_count: 3,
    projects: [
      { id: 0, identifier: 'p0', enabled_modules: [{ name: 'wiki' }] },
      { id: 1, identifier: 'p1', enabled_modules: [{ name: 'wiki' }] },
    ],
  });
  pool.intercept({ path: /offset=2/, method: 'GET' }).reply(200, {
    total_count: 3,
    projects: [{ id: 2, identifier: 'p2', enabled_modules: [{ name: 'news' }] }],
  });

  const r = await fetchModuleSummary(BASE, 'key', { retries: 0 });
  assert.equal(r.projectCount, 3);
  assert.equal(r.modules.find((m) => m.name === 'wiki').inUse, 2);
  assert.equal(r.modules.find((m) => m.name === 'news').inUse, 1);
});

test('fetchModuleSummary: 401 はリトライせず即失敗', async () => {
  const pool = mockPool();
  let calls = 0;
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(() => {
      calls++;
      return { statusCode: 401, data: '' };
    })
    .persist();

  await assert.rejects(fetchModuleSummary(BASE, 'key', { retries: 3 }), /401/);
  assert.equal(calls, 1);
});

test('fetchModuleSummary: 429 はリトライして成功(Retry-After尊重)', async () => {
  const pool = mockPool();
  pool
    .intercept({ path: PROJECTS, method: 'GET' })
    .reply(429, '', { headers: { 'retry-after': '0' } });
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {
    total_count: 1,
    projects: [{ id: 1, identifier: 'a', enabled_modules: [{ name: 'wiki' }] }],
  });

  const r = await fetchModuleSummary(BASE, 'key', { retries: 3 });
  assert.equal(r.projectCount, 1);
});

test('runToggle(off): 差分ありは更新・差分なしはスキップ・PUT本文が正しい', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {
    total_count: 2,
    projects: [
      { id: 1, identifier: 'has', enabled_modules: [{ name: 'wiki' }, { name: 'news' }] }, // wiki off → 差分あり
      { id: 2, identifier: 'none', enabled_modules: [{ name: 'news' }] }, // wiki 無し → 差分なし
    ],
  });

  const bodies = [];
  pool.intercept({ path: '/projects/has.json', method: 'PUT' }).reply((opts) => {
    bodies.push(opts.body);
    return { statusCode: 200, data: {} };
  });

  const r = await runToggle({ url: BASE, apiKey: 'key', modules: ['wiki'], mode: 'off', delayMs: 0, retries: 0 });
  assert.equal(r.updated, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.total, 2);

  const body = JSON.parse(bodies[0]);
  assert.deepEqual(body.project.enabled_module_names.sort(), ['news']); // news 保持 / wiki 除外
});

test('runToggle(on): 選択モジュールを和集合で追加', async () => {
  const pool = mockPool();
  pool.intercept({ path: PROJECTS, method: 'GET' }).reply(200, {
    total_count: 1,
    projects: [{ id: 1, identifier: 'a', enabled_modules: [{ name: 'news' }] }],
  });

  const bodies = [];
  pool.intercept({ path: '/projects/a.json', method: 'PUT' }).reply((opts) => {
    bodies.push(opts.body);
    return { statusCode: 200, data: {} };
  });

  const r = await runToggle({ url: BASE, apiKey: 'key', modules: ['wiki'], mode: 'on', delayMs: 0, retries: 0 });
  assert.equal(r.updated, 1);
  const body = JSON.parse(bodies[0]);
  assert.deepEqual(body.project.enabled_module_names.sort(), ['news', 'wiki']);
});

test('runToggle: モジュール未選択はエラー', async () => {
  await assert.rejects(runToggle({ url: BASE, apiKey: 'key', modules: [], mode: 'off' }), /選択されていません/);
});
