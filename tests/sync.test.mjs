import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine, toDocs, stableStringify, createHousehold, createInvite, joinHousehold, getHouseholdId, makeInviteCode } from '../js/sync.js';
import { defaultState } from '../js/store.js';

// Firestore の代わりになる、メモリ上の簡易データベース（2台の端末で共有する）
const DELETE = Symbol('delete');
function fakeFirestore() {
  const docs = new Map();
  const docSubs = new Map();
  const colSubs = new Map();
  const parent = (p) => p.split('/').slice(0, -1).join('/');
  const idOf = (p) => p.split('/').pop();
  const notify = (p, type) => {
    for (const cb of docSubs.get(p) || []) cb({ data: docs.has(p) ? structuredClone(docs.get(p)) : null, pending: false });
    for (const cb of colSubs.get(parent(p)) || []) cb([{ id: idOf(p), type, data: docs.has(p) ? structuredClone(docs.get(p)) : null, pending: false }]);
  };
  const mergeDeep = (a, b) => {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b)) {
      if (v === DELETE) delete out[k];
      else if (v && typeof v === 'object' && !Array.isArray(v) && !v.op) out[k] = mergeDeep(out[k], v);
      else out[k] = v;
    }
    return out;
  };
  const applyOps = (cur, data) => {
    const out = { ...(cur || {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v?.op === 'union') out[k] = [...new Set([...(out[k] || []), ...v.values])];
      else if (v?.op === 'remove') out[k] = (out[k] || []).filter((x) => !v.values.includes(x));
      else out[k] = v;
    }
    return out;
  };
  const writes = [];
  const adapter = {
    getDoc: async (p) => (docs.has(p) ? structuredClone(docs.get(p)) : null),
    getCollection: async (p) => [...docs.entries()].filter(([k]) => parent(k) === p).map(([k, v]) => ({ id: idOf(k), data: structuredClone(v) })),
    setDoc: async (p, data, opts = {}) => {
      writes.push(p);
      const existed = docs.has(p);
      docs.set(p, opts.merge ? mergeDeep(docs.get(p), data) : structuredClone(data));
      notify(p, existed ? 'modified' : 'added');
    },
    updateDoc: async (p, data) => {
      if (!docs.has(p)) throw new Error('not found');
      docs.set(p, applyOps(docs.get(p), data));
      notify(p, 'modified');
    },
    deleteDoc: async (p) => {
      writes.push(p);
      docs.delete(p);
      notify(p, 'removed');
    },
    onDoc: (p, cb) => {
      if (!docSubs.has(p)) docSubs.set(p, new Set());
      docSubs.get(p).add(cb);
      return () => docSubs.get(p).delete(cb);
    },
    onCollection: (p, cb) => {
      if (!colSubs.has(p)) colSubs.set(p, new Set());
      colSubs.get(p).add(cb);
      return () => colSubs.get(p).delete(cb);
    },
    deleteField: () => DELETE,
    arrayUnion: (...values) => ({ op: 'union', values }),
    arrayRemove: (...values) => ({ op: 'remove', values }),
  };
  return { adapter, docs, writes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function device(adapter, hid, S = defaultState()) {
  const dev = { S, remoteCount: 0 };
  dev.engine = new SyncEngine({ adapter, hid, getState: () => dev.S, onRemote: () => { dev.remoteCount++; } });
  return dev;
}

const recipe = (id, name) => ({ id, name, type: 'main', servings: 4, ingredients: [{ name: '玉ねぎ', amount: 1, unit: '個', category: '野菜' }], steps: ['切る'] });

test('キーの順番が違っても同じ JSON になる', () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test('APIキーは共有を選んだときだけアップロードする', () => {
  const S = defaultState();
  S.settings.apiKey = 'SECRET';
  assert.equal(toDocs(S).get('state/core').settings.apiKey, undefined);
  S.settings.shareApiKey = true;
  assert.equal(toDocs(S).get('state/core').settings.apiKey, 'SECRET');
});

test('家族グループを作って招待コードで参加すると、データが相手の端末に届く', async () => {
  const { adapter } = fakeFirestore();
  const papa = { uid: 'u-papa', displayName: '夫', email: 'papa@example.com' };
  const mama = { uid: 'u-mama', displayName: '妻', email: 'mama@example.com' };

  // 夫：家族グループを作ってアップロード
  const hid = await createHousehold(adapter, papa, () => 'h1');
  const A = device(adapter, hid);
  A.S.recipes.push(recipe('r1', '肉じゃが'));
  A.S.plans['2026-09-28'] = { weekStart: '2026-09-28', days: [{ date: '2026-09-28', mainId: 'r1', sideIds: [], absent: [] }] };
  A.S.pantry.push({ id: 'p1', name: '豚こま', amount: 300, unit: 'g', staple: false });
  A.S.settings.apiKey = 'PAPA-KEY';
  A.engine.push();
  A.engine.subscribe();
  const code = await createInvite(adapter, hid, papa.uid);
  assert.match(code, /^[A-Z2-9]{6}$/);

  // 妻：招待コードで参加し、データを受け取る
  const joined = await joinHousehold(adapter, code.toLowerCase(), mama);
  assert.equal(joined, hid);
  assert.equal(await getHouseholdId(adapter, 'u-mama'), hid);
  const B = device(adapter, hid);
  B.S.settings.apiKey = 'MAMA-KEY';
  await B.engine.pull();
  B.engine.subscribe();
  assert.equal(B.S.recipes[0].name, '肉じゃが');
  assert.equal(B.S.plans['2026-09-28'].days[0].mainId, 'r1');
  assert.equal(B.S.pantry[0].name, '豚こま');
  assert.equal(B.S.settings.apiKey, 'MAMA-KEY', '共有していないAPIキーは自分のものを使う');

  const house = (await adapter.getDoc(`households/${hid}`));
  assert.deepEqual(house.members, ['u-papa', 'u-mama']);

  // 妻が在庫を変える → 夫の端末に反映
  B.S.pantry[0].amount = 100;
  B.engine.push();
  await tick();
  assert.equal(A.S.pantry[0].amount, 100);
  assert.ok(A.remoteCount > 0);

  // 夫がレシピを削除 → 妻の端末からも消える
  A.S.recipes = [];
  delete A.S.plans['2026-09-28'];
  A.engine.push();
  await tick();
  assert.equal(B.S.recipes.length, 0);
  assert.equal(B.S.plans['2026-09-28'], undefined);
});

test('買い物のチェックは夫婦で同時に付けても消し合わない', async () => {
  const { adapter } = fakeFirestore();
  const A = device(adapter, 'h1');
  const B = device(adapter, 'h1');
  A.engine.push();
  await B.engine.pull();
  A.engine.subscribe();
  B.engine.subscribe();
  // 同時に別の品目をチェック（相手の変更が届く前に自分も書く）
  A.S.checks['2026-09-28'] = { タマネギ: true };
  B.S.checks['2026-09-28'] = { ニンジン: true };
  A.engine.push();
  B.engine.push();
  await tick();
  const saved = (await adapter.getDoc('households/h1/checks/2026-09-28')).c;
  assert.deepEqual(Object.keys(saved).sort(), ['タマネギ', 'ニンジン']);
  // チェックを外すと相手からも外れる
  A.S.checks['2026-09-28'] = { ...A.S.checks['2026-09-28'] };
  delete A.S.checks['2026-09-28'].タマネギ;
  A.engine.push();
  await tick();
  assert.deepEqual(Object.keys((await adapter.getDoc('households/h1/checks/2026-09-28')).c), ['ニンジン']);
  assert.equal(B.S.checks['2026-09-28'].タマネギ, undefined);
});

test('変わっていないドキュメントは書き込まない', async () => {
  const { adapter, writes } = fakeFirestore();
  const A = device(adapter, 'h1');
  A.S.recipes.push(recipe('r1', 'a'), recipe('r2', 'b'));
  A.engine.push();
  const n = writes.length;
  assert.equal(A.engine.push(), 0);
  A.S.recipes[1].name = 'c';
  A.engine.push();
  assert.deepEqual(writes.slice(n), ['households/h1/recipes/r2']);
});

test('間違った招待コードではエラーになる', async () => {
  const { adapter } = fakeFirestore();
  await assert.rejects(joinHousehold(adapter, 'ZZZZZZ', { uid: 'x' }), /招待コードが見つかりません/);
  assert.equal(makeInviteCode(() => 0), 'AAAAAA');
});
