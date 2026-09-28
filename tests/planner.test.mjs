import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateShopping, buildWeek, dayServings, scaleQty, pickProteinTargets, pickBuiltin, formatBase, gramHint, ingGrams, isDisliked, likeCount, recipeVegKeys, recipeFlavorKeys, recipeStyleKeys } from '../js/planner.js';
import { weekPrompt, detailPrompt } from '../js/prompts.js';
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

const byName = (n) => BUILTIN_RECIPES.find((r) => r.name === n);

test('レシピの野菜・味付け・副菜タイプを判定する', () => {
  assert.ok(recipeVegKeys(byName('肉じゃが')).includes('veg:じゃがいも'));
  assert.ok(recipeVegKeys(byName('サバの味噌煮')).length === 0);
  assert.ok(recipeFlavorKeys(byName('サバの味噌煮')).includes('flavor:味噌'));
  assert.ok(recipeFlavorKeys(byName('鶏もも肉の照り焼き')).includes('flavor:甘辛・照り焼き'));
  assert.ok(recipeFlavorKeys(byName('ポテトサラダ')).includes('flavor:マヨネーズ'));
  assert.deepEqual(recipeStyleKeys(byName('ほうれん草のごま和え')), ['style:和え物・おひたし']);
  assert.deepEqual(recipeStyleKeys(byName('鶏もも肉の照り焼き')), []);
  // AI が付けた味付けを優先
  assert.deepEqual(recipeFlavorKeys({ name: 'x', flavors: ['カレー'], ingredients: [{ name: '味噌' }] }), ['flavor:カレー']);
});

test('苦手な野菜・味付けを含むレシピは除外、好みは加点', () => {
  assert.ok(isDisliked(byName('肉じゃが'), { 'veg:じゃがいも': 'dislike' }));
  assert.ok(isDisliked(byName('サバの味噌煮'), { 'flavor:味噌': 'dislike' }));
  assert.ok(!isDisliked(byName('サバの味噌煮'), { 'veg:じゃがいも': 'dislike' }));
  assert.equal(likeCount(byName('ポテトサラダ'), { 'veg:じゃがいも': 'like', 'flavor:マヨネーズ': 'like', 'style:サラダ': 'like' }), 3);
});

test('内蔵レシピは苦手な野菜・味付けを避ける', () => {
  const prefs = { 'veg:にんじん': 'dislike', 'flavor:マヨネーズ': 'dislike' };
  for (let s = 1; s < 40; s++) {
    const b = pickBuiltin('side', null, new Set(), seeded(s), prefs);
    assert.ok(!isDisliked(b, prefs), b.name);
  }
});

test('プロンプトに野菜・味付けの好みが入る', () => {
  const text = weekPrompt({
    settings: {}, members, pantry: [], days: [{ date: '2026-09-28', absent: [] }],
    prefs: { 'veg:ブロッコリー': 'like', 'veg:ピーマン': 'dislike', 'flavor:ピリ辛': 'dislike', 'flavor:味噌': 'like', 'style:サラダ': 'like' },
    mainRequests: [], sideRequests: [{ day: 0, idx: 0, storage: '冷蔵' }],
  });
  assert.match(text, /好きな野菜: ブロッコリー/);
  assert.match(text, /使わない野菜: ピーマン/);
  assert.match(text, /好きな味付け: 味噌/);
  assert.match(text, /使わない味付け: ピリ辛/);
  assert.match(text, /好きな副菜のタイプ: サラダ/);
});

test('個数で書かれた材料の重さの目安', () => {
  assert.equal(gramHint({ name: '玉ねぎ', amount: 1, unit: '個' }), '約200g');
  assert.equal(gramHint({ name: 'かぼちゃ', amount: 0.25, unit: '個', grams: 300 }, 0.5), '約150g'); // AI の grams を優先
  assert.equal(gramHint({ name: 'ミニトマト', amount: 10, unit: '個' }), '約150g'); // 「トマト」より長い一致を優先
  assert.equal(gramHint({ name: '豚こま切れ肉', amount: 300, unit: 'g' }), '');
  assert.equal(gramHint({ name: '醤油', amount: 2, unit: '大さじ' }), '');
  assert.equal(ingGrams({ name: '謎の野菜', amount: 1, unit: '個' }), 0);
});

test('買い物リストに購入個数の重さの目安が出る', () => {
  const r = recipe('r1', [{ name: '玉ねぎ', amount: 1.5, unit: '個', category: '野菜' }]);
  const all = members.map((m) => ({ ...m, portion: 1 }));
  const { toBuy } = aggregateShopping({ days: [{ mainId: 'r1', sideIds: [], absent: [] }] }, { r1: r }, all, []);
  assert.equal(toBuy[0].buyText, '2個');
  assert.equal(toBuy[0].buyGramText, '約400g');
});

test('詳しく書き直すプロンプトは料理名と元の材料を含む', () => {
  const text = detailPrompt({ settings: {}, members, prefs: {}, pantry: [], recipe: byName('肉じゃが') });
  assert.match(text, /「肉じゃが」のまま/);
  assert.match(text, /じゃがいも 4個/);
  assert.match(text, /grams に重さの目安/);
  assert.match(text, /火加減/);
});
