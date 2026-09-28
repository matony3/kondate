import { esc, uid, addDays, defaultWeekStart, md, dow, mdw, normName, fmtNum, parseNum } from './util.js';
import { loadState, saveState, migrate } from './store.js';
import { PROTEINS, CATEGORIES, UNITS, SEASONING_PRESETS, BUILTIN_RECIPES, MEMBER_KINDS, proteinOptions, findProtein, guessCategory } from './data.js';
import {
  dayServings, buildWeek, aggregateShopping, scaleQty, pickBuiltin, pickProteinTargets,
  simplePrep, recipeUsage, planRecipeIds, canFreeze,
} from './planner.js';
import * as gemini from './gemini.js';
import * as P from './prompts.js';

let S = loadState();
const ui = {
  tab: 'plan',
  week: defaultWeekStart(),
  modal: null,
  busy: '',
  recipeFilter: 'all',
  recipeQuery: '',
  showCovered: false,
  extraRequest: '',
  rerollKey: '',
  models: [],
};
try {
  const t = localStorage.getItem('kondate-tab');
  if (t) ui.tab = t;
} catch { /* 保存できない環境 */ }

const $ = (sel) => document.querySelector(sel);
const recipeMap = () => Object.fromEntries(S.recipes.map((r) => [r.id, r]));
const getRecipe = (id) => S.recipes.find((r) => r.id === id);
const currentPlan = () => S.plans[ui.week];
const hasKey = () => !!S.settings.apiKey?.trim();

// ---------- 保存・描画 ----------

// どの献立にも使われていない AI／内蔵レシピはレシピ帳から自動で片付ける
function gcRecipes() {
  const used = new Set(Object.values(S.plans).flatMap(planRecipeIds));
  S.recipes = S.recipes.filter((r) => used.has(r.id) || r.favorite || r.weekly || r.excluded || r.keep || r.source === 'manual');
}

function commit() {
  gcRecipes();
  if (!saveState(S)) toast('保存に失敗しました（ブラウザの保存領域を確認してください）', 'error');
  render();
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 6000 : 2600);
}

function setBusy(msg) {
  ui.busy = msg;
  $('#busy').innerHTML = msg ? `<div class="busy"><div class="spinner"></div><p>${esc(msg)}</p></div>` : '';
}

function render() {
  const views = { plan: viewPlan, shop: viewShopping, pantry: viewPantry, recipes: viewRecipes, settings: viewSettings };
  $('#view').innerHTML = (views[ui.tab] || viewPlan)();
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('#modal').innerHTML = ui.modal ? renderModal() : '';
  document.body.classList.toggle('modal-open', !!ui.modal);
}

// ---------- 共通パーツ ----------

function proteinBadge(r) {
  const k = r?.protein?.kind || 'other';
  const icon = k === 'fish' ? '🐟' : k === 'meat' ? '🍖' : '🥬';
  const label = r?.protein?.label || (r?.type === 'side' ? '副菜' : 'その他');
  return `<span class="pbadge kind-${k}">${icon} ${esc(label)}</span>`;
}

function storageBadge(storage) {
  return storage === '冷凍' ? '<span class="sbadge freeze">❄️ 冷凍</span>' : '<span class="sbadge fridge">🧊 冷蔵</span>';
}

function storageWarning(r, day, i) {
  if (!r || !day) return '';
  if (day.storage === '冷凍' && !canFreeze(r)) return '冷凍に不向き';
  if (day.storage === '冷蔵' && r.storage?.fridgeDays && i + 1 > r.storage.fridgeDays) return `冷蔵は${r.storage.fridgeDays}日まで`;
  return '';
}

function membersEating(day) {
  return S.members.filter((m) => !day.absent.includes(m.id));
}

function empty(icon, title, body, action = '') {
  return `<div class="empty"><div class="empty-icon">${icon}</div><h2>${title}</h2><p>${body}</p>${action}</div>`;
}

// ---------- 献立（カレンダー） ----------

function weekNav() {
  const isDefault = ui.week === defaultWeekStart();
  return `<div class="weeknav">
    <button class="icon-btn" data-action="week" data-d="-7" aria-label="前の週">‹</button>
    <div class="weeknav-mid">
      <div class="weeknav-title">${mdw(ui.week)} 〜 ${mdw(addDays(ui.week, 4))}</div>
      ${isDefault ? '<div class="muted small">今度の作り置き</div>' : '<button class="linkish small" data-action="week-today">今度の週へ戻る</button>'}
    </div>
    <button class="icon-btn" data-action="week" data-d="7" aria-label="次の週">›</button>
  </div>`;
}

function genPanel(plan) {
  const s = S.settings;
  const mode = (v, label, sub) => `<label class="seg-opt"><input type="radio" name="mode" value="${v}" data-bind="settings.mode" ${s.mode === v ? 'checked' : ''}><span><b>${label}</b><small>${sub}</small></span></label>`;
  const sel = (bind, opts, val) => `<select data-bind="${bind}" data-type="number">${opts.map(([v, l]) => `<option value="${v}" ${Number(val) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const weekly = S.recipes.filter((r) => r.weekly && !r.excluded).length;
  return `<details class="card gen" ${plan ? '' : 'open'}>
    <summary><span>✨ ${plan ? '献立を作り直す' : '献立を提案してもらう'}</span><span class="muted small">${hasKey() ? 'Gemini' : '内蔵レシピ'}</span></summary>
    <div class="gen-body">
      <div class="field"><div class="label">レシピの選び方</div>
        <div class="seg">${mode('new', '新しいレシピ', 'すべて新提案')}${mode('balance', 'バランス', '4割を過去から')}${mode('reuse', '定番中心', '過去・お気に入り優先')}</div>
      </div>
      <div class="grid3">
        <label class="field"><span class="label">魚の日</span>${sel('settings.fishPerWeek', [0, 1, 2, 3, 4, 5].map((n) => [n, `週${n}回`]), s.fishPerWeek)}</label>
        <label class="field"><span class="label">副菜</span>${sel('settings.sidesPerDay', [[0, 'なし'], [1, '1日1品'], [2, '1日2品'], [3, '1日3品']], s.sidesPerDay)}</label>
        <label class="field"><span class="label">冷蔵する日</span>${sel('settings.fridgeDays', [[5, '全部冷蔵'], [4, '月〜木'], [3, '月〜水'], [2, '月・火']], s.fridgeDays)}</label>
      </div>
      <label class="field"><span class="label">今週のリクエスト（任意）</span>
        <textarea data-ui="extraRequest" rows="2" placeholder="例：水曜は娘の好きなハンバーグ系／野菜多めで／カレーは避けて">${esc(ui.extraRequest)}</textarea></label>
      ${weekly ? `<p class="muted small">⭐ 「毎週入れる」レシピ ${weekly}品は必ず入ります。</p>` : ''}
      ${hasKey() ? '' : '<p class="note">APIキーが未設定のため内蔵レシピから組み立てます。<button class="linkish" data-action="tab" data-tab="settings">設定でGeminiを登録</button></p>'}
      <button class="btn primary block" data-action="generate">${plan ? '🔄 この週の献立を作り直す' : '🍳 献立を作る'}</button>
    </div>
  </details>`;
}

function dishButton(r, di, slot, day) {
  if (!r) {
    return `<button class="dish empty-slot" data-action="pick-open" data-day="${di}" data-slot="${slot}">＋ ${slot === 'main' ? '主菜' : '副菜'}を選ぶ</button>`;
  }
  const warn = storageWarning(r, day, di);
  const kind = slot === 'main' ? r.protein?.kind || 'other' : 'side';
  return `<button class="dish ${slot === 'main' ? 'main' : 'side'} kind-${kind}" data-action="open-dish" data-day="${di}" data-slot="${slot}">
    <span class="dish-tag">${slot === 'main' ? '主菜' : '副菜'}${r.favorite ? ' ★' : ''}${r.weekly ? ' 🔁' : ''}${r.excluded ? ' 🚫' : ''}</span>
    <span class="dish-name">${esc(r.name)}</span>
    ${slot === 'main' && r.protein?.label ? `<span class="dish-sub">${r.protein.kind === 'fish' ? '🐟' : '🍖'} ${esc(r.protein.label)}</span>` : ''}
    ${warn ? `<span class="warn">⚠ ${warn}</span>` : ''}
  </button>`;
}

function dayCard(day, di) {
  const rm = recipeMap();
  const main = rm[day.mainId];
  const servings = dayServings(S.members, day.absent);
  const eatingChild = membersEating(day).some((m) => m.kind === 'child');
  return `<article class="day">
    <header class="day-h">
      <div class="day-date"><span class="dow">${dow(day.date)}</span><span class="md">${md(day.date)}</span></div>
      <button class="storage-toggle" data-action="toggle-storage" data-day="${di}" title="冷蔵／冷凍を切り替え">${storageBadge(day.storage)}</button>
    </header>
    <div class="dishes">
      ${dishButton(main, di, 'main', day)}
      ${day.sideIds.map((id, j) => dishButton(rm[id], di, j, day)).join('')}
    </div>
    <footer class="day-f">
      <div class="chips">${S.members.map((m) => `<button class="chip ${day.absent.includes(m.id) ? 'off' : 'on'}" data-action="toggle-member" data-day="${di}" data-member="${m.id}" aria-pressed="${!day.absent.includes(m.id)}">${esc(m.name)}</button>`).join('')}</div>
      <div class="servings">${servings > 0 ? `${fmtNum(servings)}人分` : 'なし'}${eatingChild && main?.kidsVersion ? ' <span title="子ども向けアレンジあり">👶</span>' : ''}</div>
    </footer>
  </article>`;
}

function prepSection(plan) {
  const prep = plan.prep;
  return `<section class="card">
    <div class="card-h"><h2>🧑‍🍳 日曜の作り置き段取り</h2>
      <button class="btn small" data-action="prep">${prep ? '作り直す' : '段取りを作る'}</button></div>
    ${prep ? `<p class="muted small">目安 約${Math.round((prep.totalMinutes || 0) / 5) * 5}分${prep.source === 'builtin' ? '（簡易版）' : ''}</p>
      <ol class="prep">${(prep.steps || []).map((s) => `<li><div class="prep-h"><b>${esc(s.title)}</b><span class="muted small">${s.minutes ? `${s.minutes}分` : ''}</span></div><p>${esc(s.detail)}</p></li>`).join('')}</ol>
      ${(prep.tips || []).length ? `<div class="tips">${prep.tips.map((t) => `<p>💡 ${esc(t)}</p>`).join('')}</div>` : ''}`
      : '<p class="muted">料理の順番・並行作業・冷凍のタイミングをまとめます。</p>'}
  </section>`;
}

function viewPlan() {
  const plan = currentPlan();
  let body;
  if (!plan) {
    body = empty('🗓️', 'この週の献立はまだありません', '好みや在庫に合わせて、月〜金の主菜と副菜を提案します。');
  } else {
    const rm = recipeMap();
    const mains = plan.days.map((d) => rm[d.mainId]).filter(Boolean);
    const meat = mains.filter((r) => r.protein?.kind === 'meat').length;
    const fish = mains.filter((r) => r.protein?.kind === 'fish').length;
    const fridge = plan.days.filter((d) => d.storage === '冷蔵').length;
    body = `<div class="summary">
        <span>🍖 肉 ${meat}日</span><span>🐟 魚 ${fish}日</span><span>🧊 冷蔵 ${fridge}日</span><span>❄️ 冷凍 ${plan.days.length - fridge}日</span>
      </div>
      <div class="week-grid">${plan.days.map(dayCard).join('')}</div>
      <p class="muted small hint">料理をタップするとレシピ・分量・別案。名前のボタンでその日に食べる人を切り替えると分量と買い物リストが変わります。</p>
      <button class="btn primary block" data-action="tab" data-tab="shop">🛒 買い物リストを見る</button>
      ${prepSection(plan)}`;
  }
  return `${weekNav()}${genPanel(plan)}${body}`;
}

// ---------- 買い物リスト ----------

function viewShopping() {
  const plan = currentPlan();
  if (!plan) {
    return `${weekNav()}${empty('🛒', '献立がまだありません', '先に献立を作ると、必要な材料が自動で集計されます。', '<button class="btn primary" data-action="tab" data-tab="plan">献立を作る</button>')}`;
  }
  const { toBuy, covered } = aggregateShopping(plan, recipeMap(), S.members, S.pantry);
  const checks = S.checks[ui.week] || {};
  const extras = S.extras[ui.week] || [];
  const total = toBuy.length + extras.length;
  const done = toBuy.filter((i) => checks[i.key]).length + extras.filter((x) => x.done).length;
  const groups = CATEGORIES.map((c) => [c, toBuy.filter((i) => i.category === c)]).filter(([, l]) => l.length);

  const itemRow = (i) => `<li class="item ${checks[i.key] ? 'done' : ''}">
      <label><input type="checkbox" data-check="${esc(i.key)}" ${checks[i.key] ? 'checked' : ''}>
        <span class="item-main"><span class="item-name">${esc(i.name)}</span>
          <span class="item-sub">${i.partial ? `必要 ${esc(i.needText)} − 在庫 ${esc(i.haveText)}` : ''}${i.pantryNote ? ` 在庫: ${esc(i.pantryNote)}（要確認）` : ''}</span>
          <span class="item-src">${esc(i.sources.join('・'))}</span></span>
        <span class="item-qty">${esc(i.buyText)}</span></label></li>`;

  return `${weekNav()}
    <div class="card progress-card">
      <div class="progress-h"><b>${done} / ${total}</b><span class="muted small">購入済み</span></div>
      <div class="progress"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div>
    </div>
    ${groups.map(([c, l]) => `<section class="shop-group"><h3>${esc(c)}</h3><ul class="items">${l.map(itemRow).join('')}</ul></section>`).join('')}
    <section class="shop-group"><h3>その他（手動で追加）</h3>
      <ul class="items">${extras.map((x) => `<li class="item ${x.done ? 'done' : ''}"><label><input type="checkbox" data-extra="${x.id}" ${x.done ? 'checked' : ''}><span class="item-main"><span class="item-name">${esc(x.name)}</span></span></label><button class="icon-btn small" data-action="extra-del" data-id="${x.id}" aria-label="削除">✕</button></li>`).join('')}</ul>
      <div class="inline-form"><input id="extraName" placeholder="例：牛乳、食パン"><button class="btn" data-action="extra-add">追加</button></div>
    </section>
    ${covered.length ? `<section class="shop-group covered">
      <button class="linkish" data-action="toggle-covered">${ui.showCovered ? '▼' : '▶'} 在庫でまかなえるもの（${covered.length}）</button>
      ${ui.showCovered ? `<ul class="items">${covered.map((i) => `<li class="item done"><span class="item-main"><span class="item-name">${esc(i.name)}</span><span class="item-sub">${i.staple ? '常備品' : `必要 ${esc(i.needText)} ／ 在庫 ${esc(i.haveText || 'あり')}`}</span></span></li>`).join('')}</ul>` : ''}
    </section>` : ''}
    <div class="row gap">
      <button class="btn ghost" data-action="shop-reset">チェックをリセット</button>
      <button class="btn ghost" data-action="shop-copy">📋 テキストでコピー</button>
    </div>`;
}

// ---------- 在庫 ----------

function viewPantry() {
  const staples = S.pantry.filter((p) => p.staple);
  const stock = S.pantry.filter((p) => !p.staple);
  const unitSel = (val, attrs) => `<select ${attrs}>${UNITS.map((u) => `<option ${u === val ? 'selected' : ''}>${u}</option>`).join('')}</select>`;
  const have = new Set(S.pantry.map((p) => normName(p.name)));
  const row = (p) => `<li class="prow">
      <span class="prow-name">${esc(p.name)}<small class="muted"> ${esc(p.category)}</small></span>
      ${p.staple ? '<span class="muted small">常備</span>' : `<input type="number" inputmode="decimal" min="0" step="any" value="${p.amount}" data-pantry="amount" data-id="${p.id}" class="num">${unitSel(p.unit, `data-pantry="unit" data-id="${p.id}"`)}`}
      <button class="icon-btn small" data-action="pantry-del" data-id="${p.id}" aria-label="削除">✕</button>
    </li>`;
  return `<section class="card">
      <h2>📦 家にある食材を登録</h2>
      <p class="muted small">登録した食材は買い物リストで差し引かれ、献立の提案でも優先して使われます（例：豚こま 500g 必要で 300g あれば 200g だけ購入）。</p>
      <div class="pform">
        <input id="pName" placeholder="食材名（例：豚こま切れ肉）" list="pSuggest">
        <datalist id="pSuggest">${[...new Set(BUILTIN_RECIPES.flatMap((r) => r.ingredients.map((i) => i.name)))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="row gap">
          <input id="pAmount" type="number" inputmode="decimal" min="0" step="any" placeholder="量" class="num">
          ${unitSel('g', 'id="pUnit"')}
          <label class="check"><input type="checkbox" id="pStaple"> 常備品</label>
          <button class="btn primary" data-action="pantry-add">追加</button>
        </div>
      </div>
      <div class="field"><div class="label">よく使う調味料（タップで常備品に追加）</div>
        <div class="chips wrap">${SEASONING_PRESETS.map((n) => `<button class="chip ${have.has(normName(n)) ? 'on' : 'off'}" data-action="pantry-quick" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      </div>
    </section>
    <section class="card"><h2>食材の在庫（${stock.length}）</h2>
      ${stock.length ? `<ul class="plist">${stock.map(row).join('')}</ul>` : '<p class="muted">まだ登録がありません。</p>'}
    </section>
    <section class="card"><h2>常備品（${staples.length}）</h2>
      <p class="muted small">常備品は量に関係なく「家にある」とみなし、買い物リストから外します。</p>
      ${staples.length ? `<ul class="plist">${staples.map(row).join('')}</ul>` : '<p class="muted">まだ登録がありません。</p>'}
    </section>`;
}

// ---------- レシピ帳 ----------

function recipeListHtml() {
  const usage = recipeUsage(S.plans);
  const q = normName(ui.recipeQuery);
  const f = ui.recipeFilter;
  const list = S.recipes
    .filter((r) => (f === 'all' ? !r.excluded : f === 'main' ? r.type === 'main' && !r.excluded : f === 'side' ? r.type === 'side' && !r.excluded : f === 'favorite' ? r.favorite : f === 'weekly' ? r.weekly : f === 'excluded' ? r.excluded : true))
    .filter((r) => !q || normName(r.name).includes(q) || normName(r.protein?.label).includes(q))
    .sort((a, b) => (b.favorite - a.favorite) || (usage[b.id] || 0) - (usage[a.id] || 0) || a.name.localeCompare(b.name, 'ja'));
  if (!list.length) return '<p class="muted center">該当するレシピはありません。</p>';
  return `<ul class="rlist">${list.map((r) => `<li class="rrow">
      <button class="rrow-main" data-action="recipe-open" data-id="${r.id}">
        <span class="rrow-name">${esc(r.name)}</span>
        <span class="rrow-meta">${r.type === 'main' ? '主菜' : '副菜'} ${r.type === 'main' ? proteinBadge(r) : ''} <span class="muted small">${usage[r.id] ? `${usage[r.id]}週で使用` : '未使用'}${r.source === 'manual' ? '・手動登録' : ''}</span></span>
      </button>
      <div class="rrow-flags">
        <button class="flag ${r.favorite ? 'on' : ''}" data-action="recipe-flag" data-flag="favorite" data-id="${r.id}" title="お気に入り">★</button>
        <button class="flag ${r.weekly ? 'on' : ''}" data-action="recipe-flag" data-flag="weekly" data-id="${r.id}" title="毎週入れる">🔁</button>
        <button class="flag ${r.excluded ? 'on danger' : ''}" data-action="recipe-flag" data-flag="excluded" data-id="${r.id}" title="今後入れない">🚫</button>
      </div></li>`).join('')}</ul>`;
}

function viewRecipes() {
  const filters = [['all', 'すべて'], ['main', '主菜'], ['side', '副菜'], ['favorite', '★お気に入り'], ['weekly', '🔁毎週'], ['excluded', '🚫除外']];
  return `<section class="card">
      <h2>📚 レシピ帳</h2>
      <p class="muted small">献立に使ったレシピが自動で残ります。★お気に入り・🔁毎週入れる・🚫今後入れない を設定すると次回の提案に反映されます。</p>
      <div class="row gap wrap">
        <button class="btn" data-action="add-ai-open">✨ 料理名からAIで登録</button>
        <button class="btn ghost" data-action="add-manual-open">✍️ 手動で登録</button>
      </div>
    </section>
    <div class="chips wrap filters">${filters.map(([k, l]) => `<button class="chip ${ui.recipeFilter === k ? 'on' : 'off'}" data-action="recipe-filter" data-f="${k}">${l}</button>`).join('')}</div>
    <input id="recipeSearch" class="search" type="search" placeholder="🔍 料理名・食材で検索" value="${esc(ui.recipeQuery)}">
    <div id="recipeList">${recipeListHtml()}</div>`;
}

// ---------- 設定 ----------

function viewSettings() {
  const s = S.settings;
  const prefBtn = (o) => {
    const v = S.prefs[o.key] || '';
    const icon = v === 'like' ? '👍' : v === 'dislike' ? '👎' : '';
    return `<button class="chip pref ${v || 'neutral'}" data-action="pref" data-key="${esc(o.key)}">${icon} ${esc(o.cut)}</button>`;
  };
  const opts = proteinOptions();
  return `<section class="card">
      <h2>🔑 Gemini API（Google AI Studio）</h2>
      <p class="muted small"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> で発行したAPIキーを貼り付けてください。キーはこの端末のブラウザ内だけに保存され、Google以外には送信されません。</p>
      <label class="field"><span class="label">APIキー</span><input type="password" autocomplete="off" data-bind="settings.apiKey" value="${esc(s.apiKey)}" placeholder="AIza..."></label>
      <label class="field"><span class="label">モデル</span><input list="modelList" data-bind="settings.model" value="${esc(s.model)}">
        <datalist id="modelList">${[...new Set(['gemini-3.8-flash', ...ui.models])].map((m) => `<option value="${esc(m)}">`).join('')}</datalist></label>
      <div class="row gap wrap"><button class="btn" data-action="models">モデル一覧を取得</button><button class="btn" data-action="test-api">接続テスト</button></div>
      ${ui.models.length ? `<p class="muted small">利用可能: ${ui.models.map(esc).join('、')}</p>` : ''}
    </section>

    <section class="card">
      <h2>👨‍👩‍👧‍👦 家族と分量</h2>
      <p class="muted small">「量」は大人1人を1としたときの割合です。「いつも食べる」を外すと、その人は最初から食べない扱いになります（献立画面で日ごとに切り替えできます）。</p>
      <ul class="mlist">${S.members.map((m) => `<li class="mrow">
        <input value="${esc(m.name)}" data-member="name" data-id="${m.id}" class="mname" aria-label="名前">
        <select data-member="kind" data-id="${m.id}">${Object.entries(MEMBER_KINDS).map(([k, v]) => `<option value="${k}" ${m.kind === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        <label class="mini">量<input type="number" step="0.1" min="0" value="${m.portion}" data-member="portion" data-id="${m.id}" class="num"></label>
        <label class="check"><input type="checkbox" data-member="default" data-id="${m.id}" ${m.default !== false ? 'checked' : ''}>いつも食べる</label>
        <button class="icon-btn small" data-action="member-del" data-id="${m.id}" aria-label="削除">✕</button>
      </li>`).join('')}</ul>
      <button class="btn ghost" data-action="member-add">＋ 家族を追加</button>
    </section>

    <section class="card">
      <h2>🍖🐟 主菜の好み</h2>
      <p class="muted small">タップで 👍好き → 👎避ける → 未設定 と切り替わります。👍は選ばれやすく、👎は提案されません。</p>
      ${PROTEINS.map((g) => `<div class="pref-group"><div class="label">${g.kind === 'fish' ? '🐟 魚' : '🍖 ' + esc(g.type)}</div>
        <div class="chips wrap">${opts.filter((o) => o.type === g.type).map(prefBtn).join('')}</div></div>`).join('')}
      <label class="field"><span class="label">アレルギー・苦手な食材・その他の要望</span>
        <textarea rows="3" data-bind="settings.notes" placeholder="例：娘はきのこが苦手／えびアレルギーなし／平日は20時に食べる">${esc(s.notes)}</textarea></label>
    </section>

    <section class="card">
      <h2>💾 データ</h2>
      <p class="muted small">データはこの端末のブラウザに保存されています。機種変更や別の端末で使う場合はバックアップを書き出して読み込んでください（APIキーは含まれません）。</p>
      <div class="row gap wrap">
        <button class="btn" data-action="export">バックアップを書き出す</button>
        <label class="btn">バックアップを読み込む<input type="file" id="importFile" accept="application/json,.json" hidden></label>
        ${currentPlan() ? '<button class="btn ghost" data-action="delete-plan">表示中の週の献立を削除</button>' : ''}
        <button class="btn danger ghost" data-action="reset">すべて初期化</button>
      </div>
    </section>`;
}

// ---------- モーダル ----------

function renderModal() {
  const m = ui.modal;
  const inner = m.kind === 'recipe' ? recipeModal(m) : m.kind === 'picker' ? pickerModal(m) : m.kind === 'add-ai' ? addAiModal() : m.kind === 'add-manual' ? addManualModal() : '';
  if (!inner) return '';
  return `<div class="modal-bg" data-action="modal-bg"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
}

function sheetHead(eyebrow, title, extra = '') {
  return `<header class="sheet-h"><div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2>${extra}</div><button class="icon-btn" data-action="close-modal" aria-label="閉じる">✕</button></header>`;
}

function recipeModal(m) {
  const r = getRecipe(m.id);
  if (!r) return '';
  const plan = currentPlan();
  const ctx = m.ctx;
  const day = ctx && plan ? plan.days[ctx.day] : null;
  const f = m.servings / (Number(r.servings) || 4);
  const eyebrow = day ? `${mdw(day.date)}・${ctx.slot === 'main' ? '主菜' : '副菜'}` : r.type === 'main' ? '主菜' : '副菜';
  const warn = day ? storageWarning(r, day, ctx.day) : '';
  const who = day ? membersEating(day).map((x) => `${x.name}${Number(x.portion) !== 1 ? `(${x.portion})` : ''}`).join('・') : '';
  const st = r.storage || {};
  const opts = proteinOptions();

  const slotActions = ctx ? `<section class="slot-actions">
      <h3>この日の料理を変更</h3>
      ${ctx.slot === 'main' ? `<label class="field"><span class="label">別案の主食材</span><select data-ui="rerollKey">
        <option value="">同じ主食材（${esc(r.protein?.label || 'おまかせ')}）</option><option value="auto" ${ui.rerollKey === 'auto' ? 'selected' : ''}>おまかせ</option>
        ${opts.map((o) => `<option value="${esc(o.key)}" ${ui.rerollKey === o.key ? 'selected' : ''}>${o.kind === 'fish' ? '🐟' : '🍖'} ${esc(o.label)}</option>`).join('')}</select></label>` : ''}
      <div class="row gap wrap">
        <button class="btn primary" data-action="reroll">🔄 別の案にする</button>
        <button class="btn" data-action="pick-open" data-day="${ctx.day}" data-slot="${ctx.slot}">📚 レシピ帳から選ぶ</button>
      </div>
      <div class="field"><div class="label">ほかの曜日と入れ替え</div><div class="chips">
        ${plan.days.map((d, i) => (i === ctx.day ? '' : `<button class="chip off" data-action="swap-day" data-to="${i}">${dow(d.date)}</button>`)).join('')}</div></div>
      <button class="linkish danger" data-action="slot-clear">この枠を空にする</button>
    </section>` : '';

  return `${sheetHead(eyebrow, esc(r.name), `<div class="row gap wrap">${r.type === 'main' ? proteinBadge(r) : ''}${r.time ? `<span class="muted small">⏱ ${r.time}分</span>` : ''}${day ? storageBadge(day.storage) : ''}</div>`)}
    <div class="flags">
      <button class="flag-btn ${r.favorite ? 'on' : ''}" data-action="recipe-flag" data-flag="favorite" data-id="${r.id}">★ お気に入り</button>
      <button class="flag-btn ${r.weekly ? 'on' : ''}" data-action="recipe-flag" data-flag="weekly" data-id="${r.id}">🔁 毎週入れる</button>
      <button class="flag-btn ${r.excluded ? 'on danger' : ''}" data-action="recipe-flag" data-flag="excluded" data-id="${r.id}">🚫 今後入れない</button>
    </div>
    ${warn ? `<p class="note warn">⚠ ${warn}です。保存方法の切り替えか、別の案をおすすめします。</p>` : ''}
    <section>
      <div class="sec-h"><h3>材料</h3>
        <div class="stepper"><button class="icon-btn small" data-action="servings" data-d="-0.5" aria-label="減らす">−</button><b>${fmtNum(m.servings)}人分</b><button class="icon-btn small" data-action="servings" data-d="0.5" aria-label="増やす">＋</button></div></div>
      ${who ? `<p class="muted small">この日食べる人: ${esc(who)}</p>` : ''}
      <ul class="ing">${(r.ingredients || []).map((i) => `<li><span>${esc(i.name)}</span><span>${esc(scaleQty(i.amount, i.unit, f))}</span></li>`).join('')}</ul>
    </section>
    <section><h3>作り方</h3><ol class="steps">${(r.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>
    <section class="box storage-box"><h3>保存と温め直し</h3>
      <p>🧊 冷蔵 ${st.fridgeDays || '-'}日 ／ ❄️ 冷凍 ${st.freezerDays ? `${st.freezerDays}日` : '不可'}</p>
      ${st.reheat ? `<p>${esc(st.reheat)}</p>` : ''}</section>
    ${r.kidsVersion ? `<section class="box kids-box"><h3>👶 子ども向けアレンジ</h3><p>${esc(r.kidsVersion)}</p></section>` : ''}
    ${r.point ? `<section class="box tip-box"><h3>💡 作り置きのコツ</h3><p>${esc(r.point)}</p></section>` : ''}
    ${slotActions}
    ${!ctx ? `<div class="row gap"><button class="linkish danger" data-action="recipe-del" data-id="${r.id}">このレシピを削除</button></div>` : ''}`;
}

function pickerModal(m) {
  const type = m.ctx.slot === 'main' ? 'main' : 'side';
  const lib = S.recipes.filter((r) => r.type === type && !r.excluded).sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name, 'ja'));
  const libNames = new Set(S.recipes.map((r) => normName(r.name)));
  const builtins = BUILTIN_RECIPES.filter((b) => b.type === type && !libNames.has(normName(b.name)));
  const row = (r, attr) => `<li><button class="pick-row" data-action="pick" ${attr}><span>${esc(r.name)}</span>${type === 'main' ? proteinBadge(r) : ''}</button></li>`;
  return `${sheetHead(mdw(currentPlan().days[m.ctx.day].date), `${type === 'main' ? '主菜' : '副菜'}を選ぶ`)}
    ${lib.length ? `<h3>レシピ帳</h3><ul class="picklist">${lib.map((r) => row(r, `data-id="${r.id}"`)).join('')}</ul>` : ''}
    <h3>内蔵レシピ</h3><ul class="picklist">${builtins.map((b) => row(b, `data-bid="${b.bid}"`)).join('')}</ul>`;
}

function addAiModal() {
  return `${sheetHead('レシピ帳', '料理名からAIで登録')}
    <p class="muted small">家族の好きな料理名を入れると、Geminiが作り置き向けレシピ（材料・保存方法・子ども向けアレンジ付き）に整えて登録します。</p>
    <label class="field"><span class="label">料理名</span><input id="aiName" placeholder="例：鶏肉のマーマレード煮、ばあばの肉じゃが"></label>
    <label class="field"><span class="label">種類</span><select id="aiType"><option value="main">主菜</option><option value="side">副菜</option></select></label>
    <label class="check"><input type="checkbox" id="aiFav" checked> お気に入りに入れる</label>
    <button class="btn primary block" data-action="add-ai">✨ 登録する</button>`;
}

function addManualModal() {
  const opts = proteinOptions();
  return `${sheetHead('レシピ帳', '手動で登録')}
    <label class="field"><span class="label">料理名</span><input id="mName"></label>
    <div class="grid3">
      <label class="field"><span class="label">種類</span><select id="mType"><option value="main">主菜</option><option value="side">副菜</option></select></label>
      <label class="field"><span class="label">主食材</span><select id="mProtein"><option value="">なし・その他</option>${opts.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')}</select></label>
      <label class="field"><span class="label">何人分</span><input id="mServings" type="number" value="4" min="1" class="num"></label>
    </div>
    <label class="field"><span class="label">材料（1行に1つ：「名前 量 単位」）</span>
      <textarea id="mIngredients" rows="6" placeholder="鶏もも肉 600 g&#10;玉ねぎ 1 個&#10;醤油 大さじ 2&#10;塩 少々"></textarea></label>
    <label class="field"><span class="label">作り方（1行に1手順）</span><textarea id="mSteps" rows="5"></textarea></label>
    <div class="grid3">
      <label class="field"><span class="label">保存</span><select id="mStorage"><option>冷蔵・冷凍</option><option>冷蔵</option><option>冷凍</option></select></label>
      <label class="field"><span class="label">冷蔵日数</span><input id="mFridge" type="number" value="3" class="num"></label>
      <label class="field"><span class="label">冷凍日数</span><input id="mFreezer" type="number" value="21" class="num"></label>
    </div>
    <label class="field"><span class="label">温め方</span><input id="mReheat"></label>
    <label class="field"><span class="label">子ども向けアレンジ</span><textarea id="mKids" rows="2"></textarea></label>
    <label class="check"><input type="checkbox" id="mFav" checked> お気に入りに入れる</label>
    <button class="btn primary block" data-action="add-manual">登録する</button>`;
}

// ---------- レシピの追加・割り当て ----------

function fromAI(src, type, target) {
  return {
    id: uid(),
    name: String(src.name || '').trim() || '名称未設定',
    type,
    servings: 4,
    time: Number(src.timeMinutes) || null,
    protein: type === 'main'
      ? target ? { kind: target.kind, key: target.key, label: target.label } : { kind: ['meat', 'fish'].includes(src.proteinKind) ? src.proteinKind : 'other', label: src.proteinLabel || '' }
      : { kind: 'other', label: '' },
    ingredients: (src.ingredients || [])
      .map((i) => ({ name: String(i.name || '').trim(), amount: Number(i.amount) || 0, unit: String(i.unit || '').trim(), category: CATEGORIES.includes(i.category) ? i.category : guessCategory(i.name) }))
      .filter((i) => i.name && !/^水$/.test(i.name)),
    steps: (src.steps || []).map(String),
    storage: { method: src.storageMethod || '冷蔵', fridgeDays: Number(src.fridgeDays) || 3, freezerDays: Number(src.freezerDays) || 0, reheat: src.reheat || '' },
    kidsVersion: src.kidsVersion || '',
    point: src.point || '',
    source: 'ai',
    favorite: false, weekly: false, excluded: false,
    createdAt: Date.now(),
  };
}

function addBuiltin(b) {
  if (!b) return null;
  const existing = S.recipes.find((r) => normName(r.name) === normName(b.name));
  if (existing) return existing.id;
  const { bid, ...rest } = b;
  const r = { ...structuredClone(rest), id: uid(), source: 'builtin', favorite: false, weekly: false, excluded: false, createdAt: Date.now() };
  S.recipes.push(r);
  return r.id;
}

function namesInDays(days) {
  const rm = recipeMap();
  return new Set(days.flatMap((d) => [d.mainId, ...d.sideIds]).filter(Boolean).map((id) => normName(rm[id]?.name)));
}

function avoidNames() {
  return S.recipes.filter((r) => r.excluded).map((r) => r.name);
}

async function generateWeek() {
  if (currentPlan() && !confirm('この週の献立を作り直しますか？（買い物リストのチェックもリセットされます）')) return;
  const sk = buildWeek({ weekStart: ui.week, settings: S.settings, members: S.members, recipes: S.recipes, prefs: S.prefs, pantry: S.pantry, plans: S.plans });
  let ai = null;
  if ((sk.mainRequests.length || sk.sideRequests.length) && hasKey()) {
    setBusy('Gemini が献立を考えています…（30秒〜1分ほど）');
    const rm = recipeMap();
    const recent = [-7, -14].flatMap((o) => planRecipeIds(S.plans[addDays(ui.week, o)])).map((id) => rm[id]?.name).filter(Boolean);
    try {
      ai = await gemini.generateJSON({
        apiKey: S.settings.apiKey.trim(),
        model: S.settings.model,
        schema: P.WEEK_SCHEMA,
        prompt: P.weekPrompt({
          settings: S.settings, members: S.members, prefs: S.prefs, pantry: S.pantry, days: sk.days,
          mainRequests: sk.mainRequests, sideRequests: sk.sideRequests,
          fixedNames: [...namesInDaysRaw(sk.days)],
          avoidNames: [...new Set([...avoidNames(), ...(S.settings.mode === 'new' ? recent : [])])],
          extraRequest: ui.extraRequest,
        }),
      });
    } catch (err) {
      setBusy('');
      if (!confirm(`${err.message}\n\n内蔵レシピで代わりに作成しますか？`)) return;
    }
  }
  const pick = (list, i) => (list || []).find((x) => x.slot === i) || null;
  const used = namesInDays(sk.days);
  sk.mainRequests.forEach((req, i) => {
    const src = pick(ai?.mains, i) || ai?.mains?.[i];
    let id;
    if (src?.name) {
      const r = fromAI(src, 'main', req.target);
      S.recipes.push(r);
      id = r.id;
    } else id = addBuiltin(pickBuiltin('main', req.target, used));
    sk.days[req.day].mainId = id;
    used.add(normName(getRecipe(id)?.name));
  });
  sk.sideRequests.forEach((req, i) => {
    const src = pick(ai?.sides, i) || ai?.sides?.[i];
    let id;
    if (src?.name) {
      const r = fromAI(src, 'side', null);
      S.recipes.push(r);
      id = r.id;
    } else id = addBuiltin(pickBuiltin('side', null, used));
    sk.days[req.day].sideIds[req.idx] = id;
    used.add(normName(getRecipe(id)?.name));
  });
  S.plans[ui.week] = { weekStart: ui.week, days: sk.days, prep: null, createdAt: Date.now() };
  S.checks[ui.week] = {};
  setBusy('');
  commit();
  toast(ai ? 'Gemini の提案で献立を作りました' : '内蔵レシピで献立を作りました');
}

function namesInDaysRaw(days) {
  const rm = recipeMap();
  return new Set(days.flatMap((d) => [d.mainId, ...d.sideIds]).filter(Boolean).map((id) => rm[id]?.name).filter(Boolean));
}

function slotId(day, slot) {
  return slot === 'main' ? day.mainId : day.sideIds[slot];
}

function setSlot(day, slot, id) {
  if (slot === 'main') day.mainId = id;
  else day.sideIds[slot] = id;
}

function parseSlot(v) {
  return v === 'main' ? 'main' : Number(v);
}

function openRecipe(id, ctx = null) {
  const r = getRecipe(id);
  if (!r) return;
  const plan = currentPlan();
  const servings = ctx && plan ? dayServings(S.members, plan.days[ctx.day].absent) || 1 : Number(r.servings) || 4;
  ui.rerollKey = '';
  ui.modal = { kind: 'recipe', id, ctx, servings };
  render();
}

async function rerollSlot() {
  const { ctx } = ui.modal;
  const plan = currentPlan();
  const day = plan.days[ctx.day];
  const type = ctx.slot === 'main' ? 'main' : 'side';
  const cur = getRecipe(slotId(day, ctx.slot));
  let target = null;
  if (type === 'main') {
    if (ui.rerollKey && ui.rerollKey !== 'auto') target = findProtein(ui.rerollKey);
    else if (!ui.rerollKey && cur?.protein?.key) target = findProtein(cur.protein.key);
    if (!target) {
      const t = pickProteinTargets({ count: 1, fishCount: Math.random() < 0.35 ? 1 : 0, prefs: S.prefs, pantry: S.pantry });
      target = t.fish[0] || t.meat[0];
    }
  }
  const others = plan.days.flatMap((d) => [d.mainId, ...d.sideIds]).filter((id) => id && id !== cur?.id).map((id) => getRecipe(id)?.name).filter(Boolean);
  let newId = null;
  if (hasKey()) {
    setBusy('Gemini が別の案を考えています…');
    try {
      const req = type === 'main' ? { day: ctx.day, storage: day.storage, target } : { day: ctx.day, idx: ctx.slot, storage: day.storage };
      const res = await gemini.generateJSON({
        apiKey: S.settings.apiKey.trim(),
        model: S.settings.model,
        schema: P.WEEK_SCHEMA,
        prompt: P.weekPrompt({
          settings: S.settings, members: S.members, prefs: S.prefs, pantry: S.pantry, days: plan.days,
          mainRequests: type === 'main' ? [req] : [], sideRequests: type === 'side' ? [req] : [],
          fixedNames: others, avoidNames: [...avoidNames(), cur?.name].filter(Boolean), extraRequest: '',
        }),
      });
      const src = (type === 'main' ? res.mains : res.sides)?.[0];
      if (src?.name) {
        const r = fromAI(src, type, target);
        S.recipes.push(r);
        newId = r.id;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy('');
  }
  if (!newId) {
    const used = new Set([...others, cur?.name].filter(Boolean).map(normName));
    newId = addBuiltin(pickBuiltin(type, target, used));
    if (hasKey()) toast('内蔵レシピから選びました');
  }
  setSlot(day, ctx.slot, newId);
  plan.prep = null;
  commit();
  openRecipe(newId, ctx);
}

async function generatePrep() {
  const plan = currentPlan();
  const rm = recipeMap();
  const dishes = [];
  plan.days.forEach((d, i) => {
    const servings = dayServings(S.members, d.absent);
    if (servings <= 0) return;
    [d.mainId, ...d.sideIds].forEach((id, j) => {
      const r = rm[id];
      if (!r) return;
      const f = servings / (Number(r.servings) || 4);
      dishes.push({
        name: r.name, type: j === 0 ? 'main' : 'side', dayLabel: `${dow(d.date)}曜`, storage: d.storage, servings: fmtNum(servings),
        ingredients: r.ingredients.map((x) => `${x.name}${scaleQty(x.amount, x.unit, f)}`).join('、'),
        steps: r.steps.join(' → '),
      });
    });
  });
  if (!dishes.length) return toast('料理がありません');
  let prep = null;
  if (hasKey()) {
    setBusy('Gemini が段取りを考えています…');
    try {
      const res = await gemini.generateJSON({ apiKey: S.settings.apiKey.trim(), model: S.settings.model, schema: P.PREP_SCHEMA, prompt: P.prepPrompt({ settings: S.settings, members: S.members, dishes }) });
      prep = { ...res, source: 'ai' };
    } catch (err) {
      toast(`${err.message}（簡易版の段取りを表示します）`, 'error');
    }
    setBusy('');
  }
  plan.prep = prep || simplePrep(dishes);
  commit();
}

function parseIngredientLine(line) {
  const t = line.normalize('NFKC').trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  const name = parts.shift();
  const rest = parts.join(' ');
  let amount = 0;
  let unit = '適量';
  let m;
  if ((m = rest.match(/^(大さじ|小さじ)\s*([\d./]+)$/))) { unit = m[1]; amount = parseNum(m[2]); }
  else if ((m = rest.match(/^([\d./]+)\s*(\S*)$/))) { amount = parseNum(m[1]); unit = m[2] || '個'; }
  else if ((m = t.match(/^(\S+?)([\d./]+)(g|ml|個|本|枚|切れ)$/))) return { name: m[1], amount: parseNum(m[2]), unit: m[3], category: guessCategory(m[1]) };
  else if (rest) unit = rest;
  return { name, amount, unit, category: guessCategory(name) };
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- アクション ----------

const actions = {
  tab: (el) => {
    ui.tab = el.dataset.tab;
    ui.modal = null;
    try { localStorage.setItem('kondate-tab', ui.tab); } catch { /* noop */ }
    render();
    window.scrollTo(0, 0);
  },
  week: (el) => { ui.week = addDays(ui.week, Number(el.dataset.d)); render(); },
  'week-today': () => { ui.week = defaultWeekStart(); render(); },
  generate: () => generateWeek(),
  'toggle-storage': (el) => {
    const d = currentPlan().days[Number(el.dataset.day)];
    d.storage = d.storage === '冷凍' ? '冷蔵' : '冷凍';
    commit();
  },
  'toggle-member': (el) => {
    const d = currentPlan().days[Number(el.dataset.day)];
    const id = el.dataset.member;
    d.absent = d.absent.includes(id) ? d.absent.filter((x) => x !== id) : [...d.absent, id];
    commit();
  },
  'open-dish': (el) => {
    const ctx = { day: Number(el.dataset.day), slot: parseSlot(el.dataset.slot) };
    openRecipe(slotId(currentPlan().days[ctx.day], ctx.slot), ctx);
  },
  'modal-bg': (el, e) => { if (e.target === el) { ui.modal = null; render(); } },
  'close-modal': () => { ui.modal = null; render(); },
  servings: (el) => {
    ui.modal.servings = Math.max(0.5, ui.modal.servings + Number(el.dataset.d));
    render();
  },
  'recipe-flag': (el) => {
    const r = getRecipe(el.dataset.id);
    const f = el.dataset.flag;
    r[f] = !r[f];
    if (f === 'excluded' && r.excluded) { r.favorite = false; r.weekly = false; }
    if (f !== 'excluded' && r[f]) r.excluded = false;
    toast({ favorite: r.favorite ? 'お気に入りに追加しました' : 'お気に入りから外しました', weekly: r.weekly ? '毎週の献立に入れます' : '毎週入れる設定を外しました', excluded: r.excluded ? '今後の提案に入れません' : '除外を解除しました' }[f]);
    commit();
  },
  'recipe-del': (el) => {
    const r = getRecipe(el.dataset.id);
    const used = Object.values(S.plans).some((p) => planRecipeIds(p).includes(r.id));
    if (used) { toast('献立で使用中のため削除できません。🚫「今後入れない」をご利用ください', 'error'); return; }
    if (!confirm(`「${r.name}」を削除しますか？`)) return;
    S.recipes = S.recipes.filter((x) => x.id !== r.id);
    ui.modal = null;
    commit();
  },
  reroll: () => rerollSlot(),
  'pick-open': (el) => {
    ui.modal = { kind: 'picker', ctx: { day: Number(el.dataset.day), slot: parseSlot(el.dataset.slot) } };
    render();
  },
  pick: (el) => {
    const { ctx } = ui.modal;
    const id = el.dataset.id || addBuiltin(BUILTIN_RECIPES.find((b) => b.bid === el.dataset.bid));
    const plan = currentPlan();
    setSlot(plan.days[ctx.day], ctx.slot, id);
    plan.prep = null;
    commit();
    openRecipe(id, ctx);
  },
  'slot-clear': () => {
    const { ctx } = ui.modal;
    const plan = currentPlan();
    setSlot(plan.days[ctx.day], ctx.slot, null);
    plan.prep = null;
    ui.modal = null;
    commit();
  },
  'swap-day': (el) => {
    const { ctx } = ui.modal;
    const plan = currentPlan();
    const a = plan.days[ctx.day];
    const b = plan.days[Number(el.dataset.to)];
    if (ctx.slot === 'main') [a.mainId, b.mainId] = [b.mainId, a.mainId];
    else {
      const j = ctx.slot;
      if (j >= b.sideIds.length) { toast('入れ替え先に副菜の枠がありません'); return; }
      [a.sideIds[j], b.sideIds[j]] = [b.sideIds[j], a.sideIds[j]];
    }
    plan.prep = null;
    ui.modal = null;
    commit();
    toast(`${dow(a.date)}曜と${dow(b.date)}曜を入れ替えました`);
  },
  prep: () => generatePrep(),
  'shop-reset': () => {
    if (!confirm('買い物のチェックをすべて外しますか？')) return;
    S.checks[ui.week] = {};
    (S.extras[ui.week] || []).forEach((x) => { x.done = false; });
    commit();
  },
  'shop-copy': async () => {
    const { toBuy } = aggregateShopping(currentPlan(), recipeMap(), S.members, S.pantry);
    const checks = S.checks[ui.week] || {};
    const lines = [`🛒 ${mdw(ui.week)}〜の買い物`];
    for (const c of CATEGORIES) {
      const l = toBuy.filter((i) => i.category === c && !checks[i.key]);
      if (l.length) lines.push(`【${c}】`, ...l.map((i) => `・${i.name} ${i.buyText}`));
    }
    const ex = (S.extras[ui.week] || []).filter((x) => !x.done);
    if (ex.length) lines.push('【その他】', ...ex.map((x) => `・${x.name}`));
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('コピーしました。LINEなどに貼り付けできます');
    } catch {
      toast('コピーできませんでした', 'error');
    }
  },
  'toggle-covered': () => { ui.showCovered = !ui.showCovered; render(); },
  'extra-add': () => {
    const name = $('#extraName').value.trim();
    if (!name) return;
    (S.extras[ui.week] ||= []).push({ id: uid(), name, done: false });
    commit();
  },
  'extra-del': (el) => {
    S.extras[ui.week] = (S.extras[ui.week] || []).filter((x) => x.id !== el.dataset.id);
    commit();
  },
  'pantry-add': () => {
    const name = $('#pName').value.trim();
    if (!name) { toast('食材名を入力してください'); return; }
    const staple = $('#pStaple').checked;
    const amount = parseNum($('#pAmount').value);
    const unit = $('#pUnit').value;
    const existing = S.pantry.find((p) => normName(p.name) === normName(name) && p.unit === unit && !p.staple && !staple);
    if (existing) existing.amount = (Number(existing.amount) || 0) + amount;
    else S.pantry.push({ id: uid(), name, amount: staple ? 0 : amount, unit: staple ? '適量' : unit, category: guessCategory(name), staple });
    commit();
    toast(`${name} を登録しました`);
  },
  'pantry-quick': (el) => {
    const name = el.dataset.name;
    const ex = S.pantry.find((p) => normName(p.name) === normName(name));
    if (ex) S.pantry = S.pantry.filter((p) => p !== ex);
    else S.pantry.push({ id: uid(), name, amount: 0, unit: '適量', category: '調味料', staple: true });
    commit();
  },
  'pantry-del': (el) => { S.pantry = S.pantry.filter((p) => p.id !== el.dataset.id); commit(); },
  'recipe-filter': (el) => { ui.recipeFilter = el.dataset.f; render(); },
  'recipe-open': (el) => openRecipe(el.dataset.id),
  'add-ai-open': () => {
    if (!hasKey()) { toast('先に設定で Gemini の APIキーを登録してください', 'error'); return; }
    ui.modal = { kind: 'add-ai' };
    render();
  },
  'add-ai': async () => {
    const name = $('#aiName').value.trim();
    const type = $('#aiType').value;
    const fav = $('#aiFav').checked;
    if (!name) { toast('料理名を入力してください'); return; }
    setBusy(`「${name}」のレシピを作成中…`);
    try {
      const src = await gemini.generateJSON({ apiKey: S.settings.apiKey.trim(), model: S.settings.model, schema: P.SINGLE_SCHEMA, prompt: P.namedRecipePrompt({ settings: S.settings, members: S.members, prefs: S.prefs, pantry: S.pantry, name, type }) });
      const r = fromAI(src, type, null);
      if (type === 'main') {
        const opt = proteinOptions().find((o) => o.kw.some((set) => set.every((w) => normName(`${src.proteinLabel || ''}${r.name}`).includes(w))));
        if (opt) r.protein = { kind: opt.kind, key: opt.key, label: opt.label };
      }
      r.keep = true;
      r.favorite = fav;
      S.recipes.push(r);
      setBusy('');
      commit();
      openRecipe(r.id);
    } catch (err) {
      setBusy('');
      toast(err.message, 'error');
    }
  },
  'add-manual-open': () => { ui.modal = { kind: 'add-manual' }; render(); },
  'add-manual': () => {
    const name = $('#mName').value.trim();
    if (!name) { toast('料理名を入力してください'); return; }
    const pkey = $('#mProtein').value;
    const opt = pkey ? findProtein(pkey) : null;
    const r = {
      id: uid(), name, type: $('#mType').value, servings: Number($('#mServings').value) || 4, time: null,
      protein: opt ? { kind: opt.kind, key: opt.key, label: opt.label } : { kind: 'other', label: '' },
      ingredients: $('#mIngredients').value.split('\n').map(parseIngredientLine).filter(Boolean),
      steps: $('#mSteps').value.split('\n').map((s) => s.trim()).filter(Boolean),
      storage: { method: $('#mStorage').value, fridgeDays: Number($('#mFridge').value) || 3, freezerDays: Number($('#mFreezer').value) || 0, reheat: $('#mReheat').value.trim() },
      kidsVersion: $('#mKids').value.trim(), point: '', source: 'manual',
      favorite: $('#mFav').checked, weekly: false, excluded: false, createdAt: Date.now(),
    };
    S.recipes.push(r);
    ui.modal = null;
    commit();
    toast('レシピを登録しました');
  },
  pref: (el) => {
    const k = el.dataset.key;
    const next = { undefined: 'like', like: 'dislike', dislike: undefined }[S.prefs[k]];
    if (next) S.prefs[k] = next;
    else delete S.prefs[k];
    commit();
  },
  'member-add': () => {
    S.members.push({ id: uid(), name: '家族', kind: 'adult', portion: 1, default: true });
    commit();
  },
  'member-del': (el) => {
    const m = S.members.find((x) => x.id === el.dataset.id);
    if (!confirm(`「${m.name}」を削除しますか？`)) return;
    S.members = S.members.filter((x) => x !== m);
    commit();
  },
  models: async () => {
    if (!hasKey()) { toast('APIキーを入力してください'); return; }
    setBusy('モデル一覧を取得中…');
    try {
      ui.models = await gemini.listModels(S.settings.apiKey.trim());
      toast(`${ui.models.length}件のモデルが見つかりました`);
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy('');
    render();
  },
  'test-api': async () => {
    if (!hasKey()) { toast('APIキーを入力してください'); return; }
    setBusy('接続テスト中…');
    try {
      const res = await gemini.generateJSON({
        apiKey: S.settings.apiKey.trim(), model: S.settings.model,
        prompt: '「接続OK」とだけ message に入れて返してください。',
        schema: { type: 'OBJECT', properties: { message: { type: 'STRING' } }, required: ['message'] },
      });
      toast(`✅ ${S.settings.model}: ${res.message}`);
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy('');
  },
  export: () => {
    const data = { ...S, settings: { ...S.settings, apiKey: '' } };
    download(`kondate-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  },
  'delete-plan': () => {
    if (!confirm(`${mdw(ui.week)}〜の献立を削除しますか？`)) return;
    delete S.plans[ui.week];
    delete S.checks[ui.week];
    delete S.extras[ui.week];
    commit();
  },
  reset: () => {
    if (!confirm('献立・レシピ帳・在庫・設定をすべて削除します。よろしいですか？')) return;
    S = migrate(null);
    commit();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') e.preventDefault();
  fn(el, e);
});

function readVal(t) {
  if (t.type === 'checkbox') return t.checked;
  if (t.dataset.type === 'number' || t.type === 'number') return Number(t.value);
  return t.value;
}

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.bind) {
    const path = t.dataset.bind.split('.');
    let o = S;
    while (path.length > 1) o = o[path.shift()];
    o[path[0]] = typeof t.value === 'string' && t.type !== 'checkbox' && t.dataset.type !== 'number' ? t.value.trim() : readVal(t);
    commit();
  } else if (t.dataset.check) {
    const c = (S.checks[ui.week] ||= {});
    if (t.checked) c[t.dataset.check] = true;
    else delete c[t.dataset.check];
    commit();
  } else if (t.dataset.extra) {
    const x = (S.extras[ui.week] || []).find((y) => y.id === t.dataset.extra);
    if (x) x.done = t.checked;
    commit();
  } else if (t.dataset.pantry) {
    const p = S.pantry.find((x) => x.id === t.dataset.id);
    if (p) p[t.dataset.pantry] = t.dataset.pantry === 'amount' ? parseNum(t.value) : t.value;
    commit();
  } else if (t.dataset.member) {
    const m = S.members.find((x) => x.id === t.dataset.id);
    const f = t.dataset.member;
    if (!m) return;
    if (f === 'kind') {
      m.kind = t.value;
      m.portion = MEMBER_KINDS[t.value]?.portion ?? m.portion;
    } else m[f] = f === 'default' ? t.checked : f === 'portion' ? Math.max(0, Number(t.value) || 0) : t.value.trim() || m.name;
    if (f === 'default') {
      // 今週以降の献立にも反映する
      for (const [ws, p] of Object.entries(S.plans)) {
        if (ws < defaultWeekStart()) continue;
        for (const d of p.days) {
          d.absent = d.absent.filter((x) => x !== m.id);
          if (!m.default) d.absent.push(m.id);
        }
      }
    }
    commit();
  } else if (t.id === 'importFile' && t.files?.[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      const key = S.settings.apiKey;
      S = migrate(data);
      S.settings.apiKey = key;
      commit();
      toast('読み込みました');
    } catch {
      toast('バックアップファイルを読み込めませんでした', 'error');
    }
  } else if (t.dataset.ui) {
    ui[t.dataset.ui] = t.value;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'recipeSearch') {
    ui.recipeQuery = t.value;
    $('#recipeList').innerHTML = recipeListHtml();
  } else if (t.dataset.ui) {
    ui[t.dataset.ui] = t.value;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.modal) { ui.modal = null; render(); }
  if (e.key === 'Enter' && e.target.id === 'extraName') actions['extra-add']();
  if (e.key === 'Enter' && e.target.id === 'pName') $('#pAmount').focus();
});

render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン対応なしで続行 */ });
}
