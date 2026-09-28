import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateShopping, buildWeek, dayServings, scaleQty, pickProteinTargets, pickBuiltin, formatBase } from '../js/planner.js';
import { namesMatch, defaultWeekStart, normName } from '../js/util.js';
import { BUILTIN_RECIPES, proteinOptions, guessCategory } from '../js/data.js';

const members = [
  { id: 'a', name: '夫', kind: 'adult', portion: 1, default: true },
  { id: 'b', name: '妻', kind: 'adult', portion: 1, default: true },
  { id: 'c', name: '娘', kind: 'teen', portion: 1, default: true },
  { id: 'd', name: '子', kind: 'child', portion: 0.5, default: true },
];

const recipe = (id, ingredients, extra = {}) => ({ id, name: id, type: 'main', servings: 4, ingredients, storage: { method: '冷蔵・冷凍' }, ...extra });

function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

test('人数は欠席者を除いて合計する', () => {
  assert.equal(dayServings(members, []), 3.5);
  assert.equal(dayServings(members, ['c']), 2.5);
});

test('在庫を差し引いて購入量を計算する（500g必要・300g在庫→200g）', () => {
  const r = recipe('r1', [{ name: '豚こま切れ肉', amount: 500, unit: 'g', category: '肉' }]);
  const plan = { days: [{ mainId: 'r1', sideIds: [], absent: [] }] };
  const four = [...members.slice(0, 3), { ...members[3], portion: 1 }];
  const { toBuy } = aggregateShopping(plan, { r1: r }, four, [{ name: '豚こま', amount: 300, unit: 'g' }]);
  assert.equal(toBuy.length, 1);
  assert.equal(toBuy[0].buyText, '200g');
  assert.ok(toBuy[0].partial);
});

test('娘が食べない日は分量が減る', () => {
  const r = recipe('r1', [{ name: '鶏もも肉', amount: 400, unit: 'g', category: '肉' }]);
  const plan = { days: [{ mainId: 'r1', sideIds: [], absent: ['c'] }] };
  const { toBuy } = aggregateShopping(plan, { r1: r }, members, []);
  assert.equal(toBuy[0].buyText, '250g'); // 400 * 2.5/4
});

test('複数日の同じ材料は合算され、kgやカップも換算される', () => {
  const r1 = recipe('r1', [{ name: '玉ねぎ', amount: 1, unit: '個', category: '野菜' }, { name: '牛乳', amount: 1, unit: 'カップ', category: '卵・乳製品' }]);
  const r2 = recipe('r2', [{ name: 'たまねぎ', amount: 0.5, unit: '個', category: '野菜' }, { name: '牛乳', amount: 100, unit: 'ml', category: '卵・乳製品' }]);
  const all = members.map((m) => ({ ...m, portion: 1 }));
  const plan = { days: [{ mainId: 'r1', sideIds: ['r2'], absent: [] }] };
  const { toBuy } = aggregateShopping(plan, { r1, r2 }, all, []);
  const onion = toBuy.find((i) => i.name === '玉ねぎ');
  assert.equal(onion.buyText, '2個'); // 1.5個 → 買い物は切り上げ
  assert.equal(toBuy.find((i) => i.name === '牛乳').buyText, '300ml');
});

test('常備品の調味料は買い物リストから外れる', () => {
  const r = recipe('r1', [{ name: '醤油', amount: 2, unit: '大さじ', category: '調味料' }, { name: '塩', amount: 0, unit: '少々', category: '調味料' }]);
  const plan = { days: [{ mainId: 'r1', sideIds: [], absent: [] }] };
  const { toBuy, covered } = aggregateShopping(plan, { r1: r }, members, [{ name: 'しょうゆ', staple: true, amount: 0, unit: '適量' }]);
  assert.deepEqual(toBuy.map((i) => i.name), ['塩']);
  assert.deepEqual(covered.map((i) => i.name), ['醤油']);
});

test('名前の照合は前方一致のみ（ねぎ≠玉ねぎ）', () => {
  assert.ok(namesMatch('豚こま', '豚こま切れ肉'));
  assert.ok(namesMatch('しょうゆ', '醤油'));
  assert.ok(namesMatch('人参', 'にんじん'));
  assert.ok(!namesMatch('ねぎ', '玉ねぎ'));
  assert.ok(namesMatch('タマネギ', 'たまねぎ'));
});

test('分量の表示', () => {
  assert.equal(scaleQty(2, '大さじ', 0.5), '大さじ1');
  assert.equal(scaleQty(600, 'g', 3.5 / 4), '530g');
  assert.equal(scaleQty(0, '少々', 2), '少々');
  assert.equal(scaleQty(1, '個', 0.5), '1/2個');
  assert.equal(formatBase(9, '小さじ'), '大さじ3');
});

test('週の献立：魚の回数・保存方法・毎週レシピ', () => {
  const weekly = { ...BUILTIN_RECIPES[0], id: 'w1', weekly: true };
  const sk = buildWeek({
    weekStart: '2026-09-28',
    settings: { fishPerWeek: 2, sidesPerDay: 1, fridgeDays: 3, mode: 'new' },
    members, recipes: [weekly], rng: seeded(3),
  });
  assert.equal(sk.days.length, 5);
  assert.deepEqual(sk.days.map((d) => d.storage), ['冷蔵', '冷蔵', '冷蔵', '冷凍', '冷凍']);
  assert.equal(sk.days.filter((d) => d.mainId === 'w1').length, 1);
  assert.equal(sk.mainRequests.length, 4);
  assert.equal(sk.mainRequests.filter((r) => r.target.kind === 'fish').length, 2);
  assert.equal(sk.sideRequests.length, 5);
  assert.equal(sk.days[0].date, '2026-09-28');
  assert.equal(sk.days[4].date, '2026-10-02');
});

test('いつも食べない家族は最初から欠席扱い', () => {
  const m = members.map((x) => (x.id === 'c' ? { ...x, default: false } : x));
  const sk = buildWeek({ weekStart: '2026-09-28', settings: {}, members: m, recipes: [], rng: seeded(1) });
  assert.ok(sk.days.every((d) => d.absent.includes('c')));
});

test('除外・苦手なレシピは再利用されない', () => {
  const recipes = [
    { ...BUILTIN_RECIPES[0], id: 'x', excluded: true },
    { ...BUILTIN_RECIPES[1], id: 'y', favorite: true },
  ];
  const prefs = { [BUILTIN_RECIPES[1].protein.key]: 'dislike' };
  for (let s = 1; s < 20; s++) {
    const sk = buildWeek({ weekStart: '2026-09-28', settings: { mode: 'reuse' }, members, recipes, prefs, rng: seeded(s) });
    assert.ok(!sk.days.some((d) => d.mainId === 'x' || d.mainId === 'y'));
  }
});

test('定番中心モードではお気に入りが優先的に入る', () => {
  const recipes = BUILTIN_RECIPES.filter((r) => r.type === 'main').slice(0, 6).map((r, i) => ({ ...r, id: `r${i}`, favorite: i < 2 }));
  const sk = buildWeek({ weekStart: '2026-09-28', settings: { mode: 'reuse', sidesPerDay: 0 }, members, recipes, rng: seeded(7) });
  const ids = sk.days.map((d) => d.mainId);
  assert.ok(ids.includes('r0') && ids.includes('r1'));
  assert.equal(sk.mainRequests.length, 0);
});

test('好きな食材・在庫の食材が選ばれやすく、苦手は選ばれない', () => {
  const opts = proteinOptions();
  const dislikeAll = Object.fromEntries(opts.filter((o) => o.type === '豚肉').map((o) => [o.key, 'dislike']));
  for (let s = 1; s < 30; s++) {
    const t = pickProteinTargets({ count: 5, fishCount: 1, prefs: dislikeAll, pantry: [{ name: '鶏もも肉', amount: 300, unit: 'g' }], rng: seeded(s) });
    assert.equal(t.fish.length, 1);
    assert.ok(t.meat.every((o) => o.type !== '豚肉'));
  }
  let thigh = 0;
  for (let s = 1; s < 60; s++) {
    const t = pickProteinTargets({ count: 3, fishCount: 0, pantry: [{ name: '鶏もも肉', amount: 300, unit: 'g' }], rng: seeded(s) });
    if (t.meat.some((o) => o.key === 'meat:鶏肉:もも肉')) thigh++;
  }
  assert.ok(thigh > 40, `在庫の鶏もも肉が選ばれた回数: ${thigh}`);
});

test('内蔵レシピは主食材を優先して選ぶ', () => {
  const target = proteinOptions().find((o) => o.key === 'fish:魚:サバ');
  assert.equal(pickBuiltin('main', target, new Set(), seeded(1)).name, 'サバの味噌煮');
  const used = new Set([normName('サバの味噌煮')]);
  assert.equal(pickBuiltin('main', target, used, seeded(1)).protein.kind, 'fish');
});

test('土日に開くと次の月曜の週になる', () => {
  assert.equal(defaultWeekStart(new Date(2026, 8, 27)), '2026-09-28'); // 日曜
  assert.equal(defaultWeekStart(new Date(2026, 8, 26)), '2026-09-28'); // 土曜
  assert.equal(defaultWeekStart(new Date(2026, 8, 30)), '2026-09-28'); // 水曜
});

test('カテゴリの推定', () => {
  assert.equal(guessCategory('豚こま切れ肉'), '肉');
  assert.equal(guessCategory('生鮭'), '魚介');
  assert.equal(guessCategory('醤油'), '調味料');
  assert.equal(guessCategory('油揚げ'), '大豆製品');
  assert.equal(guessCategory('にんじん'), '野菜');
});

test('内蔵レシピのデータ整合性', () => {
  const keys = new Set(proteinOptions().map((o) => o.key));
  for (const r of BUILTIN_RECIPES) {
    assert.ok(r.bid && r.name && r.ingredients.length && r.steps.length, r.name);
    if (r.type === 'main') assert.ok(keys.has(r.protein.key), `${r.name}: ${r.protein.key}`);
  }
});
