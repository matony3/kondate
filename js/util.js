// 汎用ユーティリティ（DOM に依存しない）

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const WD = ['日', '月', '火', '水', '木', '金', '土'];

export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const w = d.getDay();
  d.setDate(d.getDate() + (w === 0 ? -6 : 1 - w));
  return ymd(d);
}

// 土日に開いたら「次の月曜」から始まる週を、平日なら今週を表示する
export function defaultWeekStart(today = new Date()) {
  const w = today.getDay();
  if (w === 0 || w === 6) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (w === 0 ? 1 : 2));
    return ymd(d);
  }
  return mondayOf(today);
}

export function md(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function dow(s) {
  return WD[parseYmd(s).getDay()];
}

// 月曜を0とした曜日の番号（0=月〜6=日）
export function weekOffset(s) {
  return (parseYmd(s).getDay() + 6) % 7;
}

export function mdw(s) {
  return `${md(s)}(${dow(s)})`;
}

// よくある漢字表記をかなに寄せる（長い語を先に置換する）
const SYNONYMS = [
  ['醤油', 'しょうゆ'], ['玉葱', 'たまねぎ'], ['玉ねぎ', 'たまねぎ'], ['玉ネギ', 'たまねぎ'], ['人参', 'にんじん'],
  ['生姜', 'しょうが'], ['大蒜', 'にんにく'], ['胡椒', 'こしょう'], ['味醂', 'みりん'], ['胡麻', 'ごま'],
  ['南瓜', 'かぼちゃ'], ['茄子', 'なす'], ['牛蒡', 'ごぼう'], ['長葱', 'ながねぎ'], ['長ねぎ', 'ながねぎ'], ['長ネギ', 'ながねぎ'],
  ['葱', 'ねぎ'], ['椎茸', 'しいたけ'], ['蓮根', 'れんこん'], ['胡瓜', 'きゅうり'], ['馬鈴薯', 'じゃがいも'],
  ['玉子', '卵'], ['たまご', '卵'], ['タマゴ', '卵'],
];

// 表記ゆれを吸収した比較用の名前（全角半角・ひらがなカタカナ・よくある漢字・括弧書き・空白）
export function normName(s) {
  let t = String(s || '').normalize('NFKC');
  for (const [a, b] of SYNONYMS) if (t.includes(a)) t = t.split(a).join(b);
  return t
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s・]/g, '')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .toLowerCase();
}

// 在庫名と材料名の照合。「豚こま」は「豚こま切れ肉」に一致するが、「ねぎ」は「玉ねぎ」に一致しない（前方一致のみ）
export function namesMatch(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 2 && l.startsWith(s);
}

export function fmtNum(x) {
  const n = Number(x) || 0;
  if (Number.isInteger(n)) return String(n);
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 100) / 100;
  const map = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' };
  if (whole === 0 && map[frac]) return map[frac];
  return String(Math.round(n * 10) / 10);
}

export function parseNum(s) {
  const t = String(s ?? '').normalize('NFKC').trim();
  if (!t) return 0;
  const m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
