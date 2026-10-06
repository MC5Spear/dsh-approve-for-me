import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { READ_TTL_MS, createSessionStore } from '../lib/session-store.js';

/**
 * 建一个测试用临时目录；用例结束自动清理。
 * @param {object} t - `node:test` 的上下文。
 * @returns {string} 目录路径。
 */
function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsafm-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 假时钟；`updatedAt` 与缓存 TTL 都由它推进，便于断言。
 * @param {number} [start] - 起始毫秒。
 * @returns {{now: () => number, advance: (ms: number) => void}} 时钟。
 */
function makeClock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

/** 写一个条目表到磁盘（绕过存储实例，模拟外部状态）。 */
function writeTable(file, entries) {
  writeFileSync(file, JSON.stringify({ version: 1, entries }), 'utf8');
}

test('文件不存在时按空表处理，首次写入懒创建（含父目录）', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'nested', 'session-models.json');
  const store = createSessionStore({ file });

  assert.equal(store.read('session-a'), undefined);
  assert.deepEqual(store.all(), {});

  assert.equal(store.write('session-a', 'zai/glm-5.3', 'high'), true);
  assert.deepEqual(store.read('session-a'), { model: 'zai/glm-5.3', effort: 'high' });

  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.version, 1);
  assert.deepEqual(Object.keys(disk.entries), ['a']);
  assert.deepEqual(disk.entries.a.model, 'zai/glm-5.3');
  assert.equal(typeof disk.entries.a.updatedAt, 'number');
});

test('带与不带 session- 前缀的 id 指向同一条目', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');
  const store = createSessionStore({ file });

  assert.equal(store.write('session-abc', 'zai/glm-5.3'), true);
  assert.deepEqual(store.read('abc'), { model: 'zai/glm-5.3', effort: '' });
  assert.deepEqual(store.read('session-abc'), { model: 'zai/glm-5.3', effort: '' });

  const other = createSessionStore({ file });
  assert.deepEqual(other.read('session-abc'), { model: 'zai/glm-5.3', effort: '' });
});

test('解析失败或结构不合法一律按空表处理，合法条目保留', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');

  writeFileSync(file, '{ not json', 'utf8');
  assert.deepEqual(createSessionStore({ file }).all(), {});

  writeTable(file, { a: { model: 'zai/glm-5.3' } });
  writeFileSync(file, JSON.stringify({ version: 2, entries: { a: { model: 'zai/glm-5.3' } } }), 'utf8');
  assert.deepEqual(createSessionStore({ file }).all(), {});

  writeTable(file, {
    a: 'nope',
    b: { model: 5 },
    c: { model: 'zai/glm-5.3', effort: 'low', updatedAt: 7 },
    d: { model: null },
  });
  const store = createSessionStore({ file });
  assert.deepEqual(store.all(), {
    c: { model: 'zai/glm-5.3', effort: 'low', updatedAt: 7 },
    d: { model: null, effort: '', updatedAt: 0 },
  });
  assert.equal(store.read('a'), undefined);
  assert.equal(store.read('b'), undefined);
  assert.deepEqual(store.read('d'), { model: null, effort: '' });
});

test('model: null 写入后读回为「跟随全局」，与未选择区分', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');
  const store = createSessionStore({ file });

  assert.equal(store.write('s', 'zai/glm-5.3', 'high'), true);
  assert.equal(store.write('s', null), true);
  assert.deepEqual(store.read('s'), { model: null, effort: '' });
  assert.equal(store.all().s.model, null);

  assert.equal(store.read('other'), undefined);
});

test('条目上限按 updatedAt 回收最旧，同一会话只保留最新一条', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');
  const clock = makeClock();
  const store = createSessionStore({ file, max: 3, now: clock.now });

  assert.equal(store.write('s1', 'p/m1'), true);
  clock.advance(10);
  assert.equal(store.write('s2', 'p/m2'), true);
  clock.advance(10);
  assert.equal(store.write('s3', 'p/m3'), true);
  clock.advance(10);
  assert.equal(store.write('s1', 'p/m1b', 'low'), true);

  assert.deepEqual(Object.keys(store.all()).sort(), ['s1', 's2', 's3']);
  assert.deepEqual(store.read('s1'), { model: 'p/m1b', effort: 'low' });

  clock.advance(10);
  assert.equal(store.write('s4', 'p/m4'), true);
  assert.deepEqual(Object.keys(store.all()).sort(), ['s1', 's3', 's4']);
  assert.equal(store.read('s2'), undefined);
  assert.deepEqual(store.read('s4'), { model: 'p/m4', effort: '' });
});

test('原子写失败不破坏旧文件，写返回 false', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');
  const store = createSessionStore({ file });

  assert.equal(store.write('s', 'p/m1'), true);
  const before = readFileSync(file, 'utf8');

  mkdirSync(`${file}.tmp`);
  assert.equal(store.write('s', 'p/m2'), false);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(store.read('s'), { model: 'p/m1', effort: '' });
  assert.deepEqual(createSessionStore({ file }).read('s'), { model: 'p/m1', effort: '' });
});

test('文件路径不可用时读返回 undefined、写返回 false，且不抛异常', (t) => {
  const dir = makeDir(t);
  const broken = createSessionStore({ file: dir });

  assert.equal(broken.read('s'), undefined);
  assert.deepEqual(broken.all(), {});
  assert.equal(broken.write('s', 'p/m1'), false);
  assert.equal(broken.clear('s'), true);

  const missing = createSessionStore({});
  assert.equal(missing.read('s'), undefined);
  assert.deepEqual(missing.all(), {});
  assert.equal(missing.write('s', 'p/m1'), false);
  assert.equal(missing.clear('s'), false);
});

test('读缓存 1 s 内不重读文件；写入成功后立即生效', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');
  const clock = makeClock();
  const store = createSessionStore({ file, now: clock.now });

  assert.equal(store.write('s', 'p/m1'), true);
  writeTable(file, { s: { model: 'p/m2', effort: '', updatedAt: 1 } });

  assert.deepEqual(store.read('s'), { model: 'p/m1', effort: '' });
  clock.advance(READ_TTL_MS);
  assert.deepEqual(store.read('s'), { model: 'p/m2', effort: '' });

  assert.equal(store.write('s', 'p/m3'), true);
  assert.deepEqual(store.read('s'), { model: 'p/m3', effort: '' });
});

test('clear 删除条目并落盘；条目不存在的会话返回 true', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');
  const store = createSessionStore({ file });

  assert.equal(store.write('s', 'p/m1'), true);
  assert.equal(store.clear('s'), true);
  assert.equal(store.read('s'), undefined);
  assert.deepEqual(store.all(), {});
  assert.equal(store.clear('s'), true);
  assert.equal(store.clear(''), false);
});

test('写入参数不合法时返回 false，不落盘', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'session-models.json');
  const store = createSessionStore({ file });

  assert.equal(store.write('', 'p/m1'), false);
  assert.equal(store.write('s', 5), false);
  assert.equal(store.write('s', '   '), false);
  assert.deepEqual(store.all(), {});
  assert.equal(store.write('s', null), true);
});
