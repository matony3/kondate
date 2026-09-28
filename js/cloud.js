// Firebase（Google ログイン＋Firestore）への接続。設定があるときだけ SDK を読み込む
const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const CONFIG_KEY = 'kondate-firebase-config';

// リポジトリの js/firebase-config.js の値を優先し、なければ設定画面で貼り付けた値を使う
export async function loadFirebaseConfig() {
  try {
    const mod = await import('./firebase-config.js');
    if (mod.firebaseConfig?.apiKey) return mod.firebaseConfig;
  } catch { /* ファイルなし */ }
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* 保存なし */ }
  return null;
}

// Firebase コンソールからコピーした「const firebaseConfig = {...}」でも JSON でも受け付ける
export function parseFirebaseConfig(text) {
  const t = String(text || '');
  const body = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  if (!body) return null;
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    // JavaScript のオブジェクト表記（キーに引用符なし）を JSON に直す
    const json = body
      .replace(/\/\/.*$/gm, '')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,\s*}/g, '}');
    try { obj = JSON.parse(json); } catch { return null; }
  }
  return obj?.apiKey && obj?.projectId && obj?.authDomain ? obj : null;
}

export function saveFirebaseConfig(config) {
  try {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    else localStorage.removeItem(CONFIG_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function connect(config) {
  const [{ initializeApp }, authMod, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const auth = authMod.getAuth(app);
  let db;
  try {
    // オフライン中の変更も端末に残し、つながったときに送る
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch {
    db = fs.getFirestore(app);
  }
  const ref = (p) => fs.doc(db, p);
  const col = (p) => fs.collection(db, p);

  const adapter = {
    getDoc: async (p) => {
      const s = await fs.getDoc(ref(p));
      return s.exists() ? s.data() : null;
    },
    getCollection: async (p) => (await fs.getDocs(col(p))).docs.map((d) => ({ id: d.id, data: d.data() })),
    setDoc: (p, data, opts) => fs.setDoc(ref(p), data, opts || {}),
    updateDoc: (p, data) => fs.updateDoc(ref(p), data),
    deleteDoc: (p) => fs.deleteDoc(ref(p)),
    onDoc: (p, cb) => fs.onSnapshot(ref(p), { includeMetadataChanges: false }, (s) => cb({ data: s.exists() ? s.data() : null, pending: s.metadata.hasPendingWrites })),
    onCollection: (p, cb) => fs.onSnapshot(col(p), (s) => cb(s.docChanges().map((c) => ({
      id: c.doc.id, type: c.type, data: c.type === 'removed' ? null : c.doc.data(), pending: c.doc.metadata.hasPendingWrites,
    })))),
    deleteField: () => fs.deleteField(),
    arrayUnion: (...v) => fs.arrayUnion(...v),
    arrayRemove: (...v) => fs.arrayRemove(...v),
  };

  const provider = new authMod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  // リダイレクトでログインして戻ってきた場合の結果を受け取る
  authMod.getRedirectResult(auth).catch((e) => console.warn('ログイン結果の取得に失敗', e));

  return {
    adapter,
    onAuth: (cb) => authMod.onAuthStateChanged(auth, cb),
    signIn: async () => {
      try {
        await authMod.signInWithPopup(auth, provider);
      } catch (e) {
        // ポップアップが使えない環境（ホーム画面から開いたアプリなど）はリダイレクトで
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) {
          await authMod.signInWithRedirect(auth, provider);
          return;
        }
        if (e.code === 'auth/popup-closed-by-user') return;
        if (e.code === 'auth/unauthorized-domain') {
          throw new Error(`このURL（${location.hostname}）がFirebaseで許可されていません。Firebase コンソールの Authentication → 設定 → 承認済みドメインに追加してください`);
        }
        throw e;
      }
    },
    signOut: () => authMod.signOut(auth),
  };
}
