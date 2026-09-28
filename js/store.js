// 端末内（localStorage）への保存
const KEY = 'kondate-app-v1';

export function defaultState() {
  return {
    version: 1,
    settings: {
      apiKey: '',
      model: 'gemini-2.5-flash',
      mode: 'balance', // new | balance | reuse
      fishPerWeek: 2,
      sidesPerDay: 1,
      fridgeDays: 3,
      notes: '',
    },
    members: [
      { id: 'm-papa', name: '夫', kind: 'adult', portion: 1, default: true },
      { id: 'm-mama', name: '妻', kind: 'adult', portion: 1, default: true },
      { id: 'm-daughter', name: '娘', kind: 'teen', portion: 1, default: true },
      { id: 'm-kid', name: 'ちびっこ', kind: 'child', portion: 0.5, default: true },
    ],
    prefs: {},
    pantry: [],
    recipes: [],
    plans: {},
    checks: {},
    extras: {},
  };
}

export function migrate(s) {
  const d = defaultState();
  if (!s || typeof s !== 'object') return d;
  return {
    ...d,
    ...s,
    settings: { ...d.settings, ...(s.settings || {}) },
    members: Array.isArray(s.members) && s.members.length ? s.members : d.members,
    prefs: s.prefs || {},
    pantry: Array.isArray(s.pantry) ? s.pantry : [],
    recipes: Array.isArray(s.recipes) ? s.recipes : [],
    plans: s.plans || {},
    checks: s.checks || {},
    extras: s.extras || {},
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('読み込みに失敗しました', e);
  }
  return defaultState();
}

export function saveState(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch (e) {
    console.warn('保存に失敗しました', e);
    return false;
  }
}
