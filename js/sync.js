// 家族（household）単位のクラウド同期。Firestore への読み書きは adapter を通して行う（テストでは偽物に差し替え）
//
// Firestore の構成
//   users/{uid}                     { householdId }
//   invites/{code}                  { householdId, createdBy, createdAt }
//   households/{hid}                { members: [uid], memberInfo: {uid: {name, email}}, invite, createdAt }
//   households/{hid}/state/core     { settings, members, prefs, pantry }
//   households/{hid}/recipes/{id}   レシピ1件
//   households/{hid}/plans/{week}   その週の献立（extras = 手動で追加した買い物も含む）
//   households/{hid}/checks/{week}  { c: { 品目キー: true } } 買い物のチェック（品目ごとに部分更新）

// キーの順番に左右されない JSON（変更検知用）
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// Firestore に保存できる形にする（undefined を除く）
const clean = (x) => JSON.parse(JSON.stringify(x ?? null));

// 端末の状態を、Firestore のドキュメント（パス → 中身）に分ける。買い物チェックは別扱い
export function toDocs(S) {
  const docs = new Map();
  const settings = { ...S.settings };
  if (!settings.shareApiKey) delete settings.apiKey;
  docs.set('state/core', clean({ settings, members: S.members, prefs: S.prefs, pantry: S.pantry }));
  for (const r of S.recipes || []) docs.set(`recipes/${r.id}`, clean(r));
  for (const [week, plan] of Object.entries(S.plans || {})) {
    docs.set(`plans/${week}`, clean({ ...plan, extras: (S.extras || {})[week] || [] }));
  }
  return docs;
}

// Firestore から読んだ中身を端末の状態に反映する
export function applyCore(S, data) {
  if (!data) return;
  const localKey = S.settings?.apiKey || '';
  S.settings = { ...S.settings, ...(data.settings || {}) };
  // APIキーを共有していないときは、この端末のキーを使い続ける
  if (!data.settings?.shareApiKey || !data.settings?.apiKey) S.settings.apiKey = localKey;
  if (Array.isArray(data.members) && data.members.length) S.members = data.members;
  S.prefs = data.prefs || {};
  S.pantry = Array.isArray(data.pantry) ? data.pantry : [];
}

export function applyRecipe(S, id, data) {
  const i = S.recipes.findIndex((r) => r.id === id);
  if (!data) {
    if (i >= 0) S.recipes.splice(i, 1);
  } else if (i >= 0) S.recipes[i] = { ...data, id };
  else S.recipes.push({ ...data, id });
}

export function applyPlan(S, week, data) {
  if (!data) {
    delete S.plans[week];
    delete S.extras[week];
    return;
  }
  const { extras, ...plan } = data;
  S.plans[week] = plan;
  S.extras[week] = extras || [];
}

export function applyChecks(S, week, data) {
  S.checks[week] = { ...(data?.c || {}) };
}

export class SyncEngine {
  // adapter: { getDoc, getCollection, setDoc, deleteDoc, onDoc, onCollection, deleteField }
  // getState: 現在の状態オブジェクトを返す関数 / onRemote: 相手の変更を反映したあとに呼ぶ / onStatus: 同期状態の通知
  constructor({ adapter, hid, getState, onRemote = () => {}, onStatus = () => {} }) {
    this.a = adapter;
    this.hid = hid;
    this.getState = getState;
    this.onRemote = onRemote;
    this.onStatus = onStatus;
    this.last = new Map(); // パス → サーバーにあると分かっている中身の JSON
    this.lastChecks = {}; // 週 → { 品目キー: true }
    this.pending = 0;
    this.unsubs = [];
  }

  path(p) {
    return `households/${this.hid}/${p}`;
  }

  // サーバーの内容をすべて読み込み、端末の状態を置き換える（ログイン直後・参加直後）
  async pull() {
    const S = this.getState();
    const [core, recipes, plans, checks] = await Promise.all([
      this.a.getDoc(this.path('state/core')),
      this.a.getCollection(this.path('recipes')),
      this.a.getCollection(this.path('plans')),
      this.a.getCollection(this.path('checks')),
    ]);
    this.last.clear();
    if (core) {
      applyCore(S, core);
      this.last.set('state/core', stableStringify(core));
    }
    S.recipes = [];
    for (const { id, data } of recipes) {
      applyRecipe(S, id, data);
      this.last.set(`recipes/${id}`, stableStringify(data));
    }
    S.plans = {};
    S.extras = {};
    for (const { id, data } of plans) {
      applyPlan(S, id, data);
      this.last.set(`plans/${id}`, stableStringify(data));
    }
    S.checks = {};
    this.lastChecks = {};
    for (const { id, data } of checks) {
      applyChecks(S, id, data);
      this.lastChecks[id] = { ...S.checks[id] };
    }
    return !!core;
  }

  track(promise) {
    this.pending++;
    this.onStatus('syncing');
    return Promise.resolve(promise)
      .then(() => {
        this.pending--;
        if (!this.pending) this.onStatus('synced');
      })
      .catch((err) => {
        this.pending--;
        console.warn('同期エラー', err);
        this.onStatus('error', err);
      });
  }

  // 端末の状態とサーバーの差分だけを書き込む
  push() {
    const S = this.getState();
    const docs = toDocs(S);
    const writes = [];
    for (const [p, data] of docs) {
      const json = stableStringify(data);
      if (this.last.get(p) === json) continue;
      this.last.set(p, json);
      writes.push(this.a.setDoc(this.path(p), data));
    }
    for (const p of [...this.last.keys()]) {
      if (!docs.has(p) && (p.startsWith('recipes/') || p.startsWith('plans/'))) {
        this.last.delete(p);
        writes.push(this.a.deleteDoc(this.path(p)));
      }
    }
    // 買い物チェックは品目ごとに部分更新（夫婦で同時にチェックしても消し合わない）
    const weeks = new Set([...Object.keys(S.checks || {}), ...Object.keys(this.lastChecks)]);
    for (const w of weeks) {
      const now = (S.checks || {})[w] || {};
      const before = this.lastChecks[w] || {};
      const diff = {};
      for (const k of new Set([...Object.keys(now), ...Object.keys(before)])) {
        if (!!now[k] !== !!before[k]) diff[k] = now[k] ? true : this.a.deleteField();
      }
      if (!Object.keys(diff).length) continue;
      this.lastChecks[w] = { ...now };
      writes.push(this.a.setDoc(this.path(`checks/${w}`), { c: diff }, { merge: true }));
    }
    if (writes.length) this.track(Promise.all(writes));
    return writes.length;
  }

  // 相手の端末での変更を受け取る
  subscribe() {
    this.stop();
    const S = () => this.getState();
    const changed = () => this.onRemote();
    this.unsubs.push(this.a.onDoc(this.path('state/core'), ({ data, pending }) => {
      if (pending || !data) return;
      const json = stableStringify(data);
      if (this.last.get('state/core') === json) return;
      this.last.set('state/core', json);
      applyCore(S(), data);
      changed();
    }));
    const onCol = (col, apply) => (changes) => {
      let any = false;
      for (const ch of changes) {
        if (ch.pending) continue;
        const p = `${col}/${ch.id}`;
        if (ch.type === 'removed') {
          if (!this.last.has(p)) continue;
          this.last.delete(p);
          apply(S(), ch.id, null);
        } else {
          const json = stableStringify(ch.data);
          if (this.last.get(p) === json) continue;
          this.last.set(p, json);
          apply(S(), ch.id, ch.data);
        }
        any = true;
      }
      if (any) changed();
    };
    this.unsubs.push(this.a.onCollection(this.path('recipes'), onCol('recipes', applyRecipe)));
    this.unsubs.push(this.a.onCollection(this.path('plans'), onCol('plans', applyPlan)));
    this.unsubs.push(this.a.onCollection(this.path('checks'), (changes) => {
      let any = false;
      for (const ch of changes) {
        if (ch.pending) continue;
        const remote = ch.type === 'removed' ? {} : { ...(ch.data?.c || {}) };
        const before = this.lastChecks[ch.id] || {};
        if (stableStringify(remote) === stableStringify(before)) continue;
        // まだ送っていない自分のチェック変更は、相手の変更の上に残す
        const local = S().checks?.[ch.id] || {};
        const next = { ...remote };
        for (const k of new Set([...Object.keys(local), ...Object.keys(before)])) {
          if (!!local[k] === !!before[k]) continue;
          if (local[k]) next[k] = true;
          else delete next[k];
        }
        this.lastChecks[ch.id] = remote;
        applyChecks(S(), ch.id, { c: next });
        any = true;
      }
      if (any) changed();
    }));
  }

  stop() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }
}

// ---------- 家族グループ ----------

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeInviteCode(rng = Math.random) {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]).join('');
}

export async function getHouseholdId(a, uid) {
  return (await a.getDoc(`users/${uid}`))?.householdId || null;
}

export async function createHousehold(a, user, newId) {
  const hid = newId();
  await a.setDoc(`households/${hid}`, {
    members: [user.uid],
    memberInfo: { [user.uid]: { name: user.displayName || '', email: user.email || '' } },
    createdAt: Date.now(),
  });
  await a.setDoc(`users/${user.uid}`, { householdId: hid });
  return hid;
}

export async function createInvite(a, hid, uid) {
  const code = makeInviteCode();
  await a.setDoc(`invites/${code}`, { householdId: hid, createdBy: uid, createdAt: Date.now() });
  await a.setDoc(`households/${hid}`, { invite: code }, { merge: true });
  return code;
}

export async function joinHousehold(a, rawCode, user) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const inv = code && (await a.getDoc(`invites/${code}`));
  if (!inv?.householdId) throw new Error('招待コードが見つかりません。コードを確認してください');
  const hid = inv.householdId;
  // セキュリティルールで「自分を members に追加するだけ」の更新として許可される
  await a.updateDoc(`households/${hid}`, { members: a.arrayUnion(user.uid), lastJoinCode: code });
  await a.setDoc(`households/${hid}`, { memberInfo: { [user.uid]: { name: user.displayName || '', email: user.email || '' } } }, { merge: true });
  await a.setDoc(`users/${user.uid}`, { householdId: hid });
  return hid;
}

export async function leaveHousehold(a, hid, uid) {
  await a.updateDoc(`households/${hid}`, { members: a.arrayRemove(uid) });
  await a.setDoc(`users/${uid}`, { householdId: null });
}
