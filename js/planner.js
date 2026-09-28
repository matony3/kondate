// 献立の組み立て・分量計算・買い物リスト集計（DOM に依存しない純粋ロジック）
import { addDays, normName, namesMatch, fmtNum, shuffle } from './util.js';
import { proteinOptions, BUILTIN_RECIPES, CATEGORIES } from './data.js';

// ---------- 人数・分量 ----------

export function dayServings(members, absent = []) {
  return members
    .filter((m) => !absent.includes(m.id))
    .reduce((s, m) => s + (Number(m.portion) || 0), 0);
}

const UNIT_BASE = {
  kg: ['g', 1000], g: ['g', 1], グラム: ['g', 1],
  L: ['ml', 1000], l: ['ml', 1000], ml: ['ml', 1], mL: ['ml', 1], cc: ['ml', 1], カップ: ['ml', 200],
  大さじ: ['小さじ', 3], 小さじ: ['小さじ', 1],
};
const VAGUE_UNITS = new Set(['少々', '適量', 'お好みで', '適宜', 'ひとつまみ', '少量']);
const WEIGHT_UNITS = new Set(['g', 'ml']);

export function isVague(unit, amount) {
  return VAGUE_UNITS.has(String(unit || '').trim()) || !(Number(amount) > 0);
}

export function toBase(amount, unit) {
  const u = String(unit || '').trim();
  const b = UNIT_BASE[u];
  if (b) return { amount: (Number(amount) || 0) * b[1], unit: b[0] };
  return { amount: Number(amount) || 0, unit: u };
}

function roundTo(x, step) {
  return Math.round(x / step) * step;
}

// 基準単位（g, ml, 小さじ, 個…）の量を読みやすく表記する
export function formatBase(amount, unit, { shopping = false } = {}) {
  if (!(amount > 0)) return '';
  if (WEIGHT_UNITS.has(unit)) {
    const step = amount < 20 ? 1 : amount < 100 ? 5 : 10;
    const v = shopping ? Math.ceil(amount / step) * step : Math.max(step, roundTo(amount, step));
    return `${v}${unit}`;
  }
  if (unit === '小さじ') {
    if (amount >= 3) return `大さじ${fmtNum(Math.max(0.5, roundTo(amount / 3, 0.5)))}`;
    return `小さじ${fmtNum(Math.max(0.5, roundTo(amount, 0.5)))}`;
  }
  const v = shopping ? Math.ceil(amount - 1e-6) : Math.max(0.25, roundTo(amount, 0.25));
  return `${fmtNum(v)}${unit}`;
}

// レシピ表示用：元の単位のまま倍率をかける
export function scaleQty(amount, unit, factor) {
  if (isVague(unit, amount)) return unit || '適量';
  const u = String(unit).trim();
  const v = Number(amount) * factor;
  if (u === '大さじ' || u === '小さじ') return `${u}${fmtNum(Math.max(0.5, roundTo(v, 0.5)))}`;
  const b = toBase(v, u);
  if (u === 'kg' || u === 'L' || u === 'l') return formatBase(b.amount, b.unit);
  return formatBase(v, u);
}

export function formatAmounts(amounts, opts) {
  return Object.entries(amounts)
    .filter(([, a]) => a > 1e-6)
    .map(([u, a]) => formatBase(a, u, opts))
    .join(' + ');
}

// ---------- 買い物リスト ----------

export function aggregateShopping(plan, recipeMap, members, pantry = []) {
  const map = new Map();
  for (const day of plan?.days || []) {
    const s = dayServings(members, day.absent || []);
    if (s <= 0) continue;
    for (const rid of [day.mainId, ...(day.sideIds || [])]) {
      const r = rid && recipeMap[rid];
      if (!r) continue;
      const f = s / (Number(r.servings) || 4);
      for (const ing of r.ingredients || []) {
        const key = normName(ing.name);
        if (!key) continue;
        let e = map.get(key);
        if (!e) {
          e = { key, name: ing.name, category: CATEGORIES.includes(ing.category) ? ing.category : 'その他', amounts: {}, vague: false, sources: new Set() };
          map.set(key, e);
        }
        e.sources.add(r.name);
        if (isVague(ing.unit, ing.amount)) {
          e.vague = true;
          continue;
        }
        const b = toBase(Number(ing.amount) * f, ing.unit);
        e.amounts[b.unit] = (e.amounts[b.unit] || 0) + b.amount;
      }
    }
  }

  const items = [];
  for (const e of map.values()) {
    const matches = pantry.filter((p) => namesMatch(p.name, e.name));
    const staple = matches.some((p) => p.staple);
    const have = {};
    const other = [];
    for (const p of matches) {
      if (p.staple) continue;
      if (isVague(p.unit, p.amount)) { other.push(p); continue; }
      const b = toBase(p.amount, p.unit);
      if (b.unit in e.amounts) have[b.unit] = (have[b.unit] || 0) + b.amount;
      else other.push(p);
    }
    const buy = {};
    for (const [u, a] of Object.entries(e.amounts)) {
      const rest = a - (have[u] || 0);
      if (rest > 1e-6) buy[u] = rest;
    }
    const hasAmounts = Object.keys(e.amounts).length > 0;
    let covered;
    if (staple) covered = true;
    else if (hasAmounts) covered = Object.keys(buy).length === 0;
    else covered = matches.length > 0;

    items.push({
      key: e.key,
      name: e.name,
      category: e.category,
      covered,
      staple,
      needText: hasAmounts ? formatAmounts(e.amounts) + (e.vague ? ' + 適量' : '') : '適量',
      haveText: formatAmounts(have),
      buyText: Object.keys(buy).length ? formatAmounts(buy, { shopping: true }) : hasAmounts ? '' : '適量',
      partial: Object.keys(have).length > 0 && !covered,
      pantryNote: other.map((p) => `${p.name}${isVague(p.unit, p.amount) ? '' : ' ' + fmtNum(p.amount) + p.unit}`).join('、'),
      sources: [...e.sources],
    });
  }
  const order = (c) => { const i = CATEGORIES.indexOf(c); return i < 0 ? 99 : i; };
  items.sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name, 'ja'));
  return { toBuy: items.filter((i) => !i.covered), covered: items.filter((i) => i.covered) };
}

// ---------- 主食材の選定 ----------

function pantryHas(opt, pantry) {
  return pantry.some((p) => {
    const n = normName(p.name);
    return opt.kw.some((set) => set.every((w) => n.includes(w)));
  });
}

export function proteinWeight(opt, prefs = {}, pantry = []) {
  const p = prefs[opt.key];
  if (p === 'dislike') return 0;
  let w = p === 'like' ? 4 : 1;
  if (pantryHas(opt, pantry)) w += 6;
  return w;
}

export function pickProteinTargets({ count, fishCount, prefs = {}, pantry = [], rng = Math.random, exclude = [] }) {
  const opts = proteinOptions();
  const meat = opts.filter((o) => o.kind === 'meat');
  const fish = opts.filter((o) => o.kind === 'fish');
  const alive = (list) => list.some((o) => proteinWeight(o, prefs, pantry) > 0);
  let f = Math.max(0, Math.min(count, Number(fishCount) || 0));
  if (!alive(fish)) f = 0;
  else if (!alive(meat)) f = count;

  const usedKeys = new Set(exclude);
  const usedTypes = {};
  const draw = (list) => {
    let ws = list.map((o) => {
      let w = proteinWeight(o, prefs, pantry);
      if (usedKeys.has(o.key)) w *= 0.1;
      if (usedTypes[o.type]) w *= 0.5 ** usedTypes[o.type];
      return w;
    });
    let tot = ws.reduce((a, b) => a + b, 0);
    if (tot <= 0) { ws = ws.map(() => 1); tot = ws.length; }
    let x = rng() * tot;
    let pick = list[list.length - 1];
    for (let i = 0; i < list.length; i++) {
      x -= ws[i];
      if (x < 0) { pick = list[i]; break; }
    }
    usedKeys.add(pick.key);
    if (pick.kind === 'meat') usedTypes[pick.type] = (usedTypes[pick.type] || 0) + 1;
    return pick;
  };
  const fishPicks = Array.from({ length: f }, () => draw(fish));
  const meatPicks = Array.from({ length: count - f }, () => draw(meat));
  return { fish: fishPicks, meat: meatPicks };
}

// ---------- 週の献立の骨組み ----------

export const REUSE_RATIO = { new: 0, balance: 0.4, reuse: 1 };

export function canFreeze(r) {
  return /冷凍/.test(r?.storage?.method || '');
}

export function isDisliked(r, prefs = {}) {
  return !!(r?.protein?.key && prefs[r.protein.key] === 'dislike');
}

export function planRecipeIds(plan) {
  const ids = [];
  for (const d of plan?.days || []) {
    if (d.mainId) ids.push(d.mainId);
    for (const s of d.sideIds || []) if (s) ids.push(s);
  }
  return ids;
}

export function recipeUsage(plans) {
  const count = {};
  for (const p of Object.values(plans || {})) {
    for (const id of new Set(planRecipeIds(p))) count[id] = (count[id] || 0) + 1;
  }
  return count;
}

// 空き枠の中から、保存方法が合う枠を選んで割り当てる
function takeSlot(free, recipe) {
  if (!free.length) return null;
  const wantFreeze = canFreeze(recipe);
  let i = wantFreeze ? free.findIndex((s) => s.storage === '冷凍') : free.findIndex((s) => s.storage === '冷蔵');
  if (i < 0) i = 0;
  return free.splice(i, 1)[0];
}

export function buildWeek({ weekStart, settings = {}, members = [], recipes = [], prefs = {}, pantry = [], plans = {}, rng = Math.random, numDays = 5 }) {
  const sidesPerDay = Math.max(0, Math.min(3, Number(settings.sidesPerDay ?? 1)));
  const fridgeDays = Number(settings.fridgeDays ?? 3);
  const defaultAbsent = members.filter((m) => m.default === false).map((m) => m.id);
  const days = Array.from({ length: numDays }, (_, i) => ({
    date: addDays(weekStart, i),
    mainId: null,
    sideIds: Array(sidesPerDay).fill(null),
    absent: [...defaultAbsent],
    storage: i < fridgeDays ? '冷蔵' : '冷凍',
  }));
  const prevIds = new Set(planRecipeIds(plans[addDays(weekStart, -7)]));
  const pool = recipes.filter((r) => !r.excluded && !isDisliked(r, prefs));
  const ratio = REUSE_RATIO[settings.mode] ?? REUSE_RATIO.balance;

  const fill = (type) => {
    const free = shuffle(
      type === 'main'
        ? days.map((d, i) => ({ day: i, storage: d.storage }))
        : days.flatMap((d, i) => d.sideIds.map((_, j) => ({ day: i, idx: j, storage: d.storage }))),
      rng,
    );
    const put = (slot, r) => {
      if (type === 'main') days[slot.day].mainId = r.id;
      else days[slot.day].sideIds[slot.idx] = r.id;
    };
    const cands = pool.filter((r) => r.type === type);
    const placed = [];
    // 1) 毎週入れるレシピ
    for (const r of shuffle(cands.filter((r) => r.weekly), rng)) {
      const slot = takeSlot(free, r);
      if (!slot) break;
      put(slot, r);
      placed.push(r);
    }
    // 2) 過去のレシピ・お気に入りから再利用
    const k = Math.round(free.length * ratio);
    if (k > 0) {
      const scored = cands
        .filter((r) => !r.weekly)
        .filter((r) => settings.mode === 'reuse' || !prevIds.has(r.id))
        .map((r) => ({ r, s: (r.favorite ? 2 : 0) - (prevIds.has(r.id) ? 3 : 0) + rng() }))
        .sort((a, b) => b.s - a.s)
        .slice(0, k);
      for (const { r } of scored) {
        const slot = takeSlot(free, r);
        if (!slot) break;
        put(slot, r);
        placed.push(r);
      }
    }
    return { free: free.sort((a, b) => a.day - b.day || (a.idx ?? 0) - (b.idx ?? 0)), placed };
  };

  const mains = fill('main');
  const sides = fill('side');

  // 3) 残りの主菜枠に主食材（肉・魚）を割り当てて新しいレシピを依頼する
  const fishUsed = mains.placed.filter((r) => r.protein?.kind === 'fish').length;
  const targets = pickProteinTargets({
    count: mains.free.length,
    fishCount: Math.max(0, (Number(settings.fishPerWeek) || 0) - fishUsed),
    prefs, pantry, rng,
    exclude: mains.placed.map((r) => r.protein?.key).filter(Boolean),
  });
  const E = mains.free;
  const fishPos = new Set(targets.fish.map((_, k) => Math.floor(((k + 0.5) * E.length) / targets.fish.length)));
  const fishQ = [...targets.fish];
  const meatQ = [...targets.meat];
  const mainRequests = E.map((slot, i) => ({
    day: slot.day,
    storage: slot.storage,
    target: (fishPos.has(i) ? fishQ.shift() : meatQ.shift()) || meatQ.shift() || fishQ.shift() || null,
  }));
  const sideRequests = sides.free.map((slot) => ({ day: slot.day, idx: slot.idx, storage: slot.storage }));

  return { days, mainRequests, sideRequests };
}

// ---------- 内蔵レシピからの選択（APIキーなし・エラー時） ----------

export function pickBuiltin(type, target, usedNames = new Set(), rng = Math.random, builtins = BUILTIN_RECIPES) {
  const all = builtins.filter((b) => b.type === type);
  const list = all.filter((b) => !usedNames.has(normName(b.name)));
  const tiers = [];
  if (type === 'main' && target) {
    const t = target.key.split(':')[1];
    tiers.push((b) => b.protein?.key === target.key);
    tiers.push((b) => b.protein?.key?.split(':')[1] === t);
    tiers.push((b) => b.protein?.kind === target.kind);
  }
  tiers.push(() => true);
  for (const tier of tiers) {
    const c = list.filter(tier);
    if (c.length) return c[Math.floor(rng() * c.length)];
  }
  return all.length ? all[Math.floor(rng() * all.length)] : null;
}

// ---------- 作り置きの段取り（AIなし版） ----------

export function simplePrep(dishes) {
  const group = (d) => {
    if (/煮|トマト|シチュー|カレー/.test(d.name)) return 0;
    if (/和え|サラダ|ナムル|浸し|スロー|マリネ|漬け/.test(d.name) && d.type === 'side') return 2;
    return 1;
  };
  const g = [[], [], []];
  for (const d of dishes) g[group(d)].push(d);
  const list = (arr) => arr.map((d) => `${d.name}（${d.dayLabel}・${d.storage}）`).join('、');
  const steps = [
    { title: '下準備', detail: '乾物（ひじき・切り干し大根など）を水で戻す。野菜はすべて洗い、同じ野菜は料理をまたいでまとめて切る。肉・魚に下味をつける。', minutes: 30 },
  ];
  if (g[0].length) steps.push({ title: '煮物・煮込みを火にかける', detail: `コンロで煮込んでいる間に次の工程へ：${list(g[0])}`, minutes: 30 });
  if (g[1].length) steps.push({ title: '焼き物・炒め物・揚げ物', detail: `空いたコンロ・グリルで順に：${list(g[1])}`, minutes: 15 * g[1].length });
  if (g[2].length) steps.push({ title: '和え物・サラダ', detail: `ゆで野菜は1つの鍋で順番にゆでると効率的：${list(g[2])}`, minutes: 10 * g[2].length });
  steps.push({ title: '冷まして保存', detail: '粗熱をしっかり取ってから容器に詰め、曜日ラベルを貼る。冷凍分はラップで空気を抜いて冷凍し、食べる前日の夜に冷蔵庫へ移して解凍する。', minutes: 15 });
  return {
    source: 'builtin',
    totalMinutes: steps.reduce((s, x) => s + x.minutes, 0),
    steps,
    tips: ['清潔な保存容器を使い、取り分けは清潔な箸で。', '冷蔵は調理後3〜4日を目安に、それ以降は冷凍がおすすめ。'],
  };
}
