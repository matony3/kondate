// Gemini に渡すプロンプトと応答スキーマ
import { CATEGORIES, MEMBER_KINDS, proteinOptions } from './data.js';
import { mdw } from './util.js';
import { dayServings } from './planner.js';

const INGREDIENT = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: '材料名' },
    amount: { type: 'NUMBER', description: '数量。少々・適量のときは0' },
    unit: { type: 'STRING', description: 'g, ml, 個, 本, 枚, 切れ, 尾, 束, 株, 玉, パック, 袋, 缶, かけ, 大さじ, 小さじ, 少々, 適量 のいずれか' },
    category: { type: 'STRING', enum: CATEGORIES },
  },
  required: ['name', 'amount', 'unit', 'category'],
};

const RECIPE = {
  type: 'OBJECT',
  properties: {
    slot: { type: 'INTEGER', description: '依頼リストの番号' },
    name: { type: 'STRING' },
    timeMinutes: { type: 'INTEGER', description: '調理時間（分）' },
    ingredients: { type: 'ARRAY', items: INGREDIENT },
    steps: { type: 'ARRAY', items: { type: 'STRING' } },
    storageMethod: { type: 'STRING', enum: ['冷蔵', '冷凍', '冷蔵・冷凍'] },
    fridgeDays: { type: 'INTEGER', description: '冷蔵での保存目安日数' },
    freezerDays: { type: 'INTEGER', description: '冷凍での保存目安日数。冷凍不可なら0' },
    reheat: { type: 'STRING', description: '食べるときの温め方・解凍方法' },
    kidsVersion: { type: 'STRING', description: '未就学児向けの取り分け・アレンジ方法' },
    point: { type: 'STRING', description: '作り置きのコツ' },
    proteinKind: { type: 'STRING', enum: ['meat', 'fish', 'other'] },
    proteinLabel: { type: 'STRING', description: '主な肉・魚（例: 鶏もも肉、サバ）。副菜は空文字' },
  },
  required: ['slot', 'name', 'timeMinutes', 'ingredients', 'steps', 'storageMethod', 'fridgeDays', 'freezerDays', 'reheat', 'kidsVersion', 'point', 'proteinKind', 'proteinLabel'],
};

export const WEEK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mains: { type: 'ARRAY', items: RECIPE },
    sides: { type: 'ARRAY', items: RECIPE },
  },
  required: ['mains', 'sides'],
};

export const SINGLE_SCHEMA = RECIPE;

export const PREP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    totalMinutes: { type: 'INTEGER' },
    steps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          detail: { type: 'STRING' },
          minutes: { type: 'INTEGER' },
        },
        required: ['title', 'detail', 'minutes'],
      },
    },
    tips: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['totalMinutes', 'steps', 'tips'],
};

function familyText(members) {
  return members
    .map((m) => `${m.name}（${MEMBER_KINDS[m.kind]?.label || '大人'}${m.default === false ? '・食べない日が多い' : ''}）`)
    .join('、');
}

function prefText(prefs) {
  const opts = proteinOptions();
  const pick = (v) => opts.filter((o) => prefs[o.key] === v).map((o) => o.label).join('、') || 'なし';
  return { like: pick('like'), dislike: pick('dislike') };
}

function pantryText(pantry) {
  const stock = pantry.filter((p) => !p.staple).map((p) => `${p.name}${p.amount > 0 ? ` ${p.amount}${p.unit}` : ''}`);
  const staple = pantry.filter((p) => p.staple).map((p) => p.name);
  return { stock: stock.join('、') || 'なし', staple: staple.join('、') || '一般的な調味料' };
}

function commonContext({ settings, members, prefs, pantry }) {
  const pr = prefText(prefs);
  const pa = pantryText(pantry);
  const hasChild = members.some((m) => m.kind === 'child');
  return `あなたは共働き家庭の「週末まとめて作り置き」を支える、日本の家庭料理に詳しい管理栄養士です。

# 家庭の前提
- 週末（日曜）にまとめて調理し、平日（月〜金）の夕食として冷蔵・冷凍保存したものを温めて食べる
- 家族: ${familyText(members)}
- 分量はすべて「大人4人分」で書く（アプリ側で人数に応じて自動で増減する）
${hasChild ? '- 未就学児（3〜6歳）がいるので、kidsVersion に「どのタイミングで取り分けるか」「味付け・切り方・食感の調整」を具体的に書く（辛味・わさび・こしょう・生もの・丸のままの豆類などは子ども分から除く）\n' : '- kidsVersion には子どもや味の好みに合わせたアレンジを一言書く\n'}- 好きな主食材: ${pr.like}
- 避けたい主食材: ${pr.dislike}
- 家にある食材（優先して使い切りたい）: ${pa.stock}
  ※在庫の食材を使うときは、材料名を在庫と同じ表記にする
- 常備している調味料など: ${pa.staple}
- アレルギー・苦手・要望: ${settings.notes?.trim() || '特になし'}`;
}

const RULES = `# 共通ルール
- 作り置きしても味や食感が落ちにくい料理にする。「冷凍」指定の料理は冷凍に向くもの（じゃがいも・豆腐・生野菜・ゆで卵・こんにゃく中心の料理は避ける）
- 平日は温め直すだけ、または5分以内の仕上げで食べられること。reheat に温め方・解凍方法を書く
- 主菜同士・副菜同士で味付け（醤油味・味噌味・洋風・中華・甘酢など）と調理法が偏らないようにする
- 市販の一般的な食材・調味料だけを使う
- 材料の unit は g, ml, 個, 本, 枚, 切れ, 尾, 束, 株, 玉, パック, 袋, 缶, かけ, 大さじ, 小さじ, 少々, 適量 のいずれか。肉・ひき肉は g、魚は 切れ か 尾 で書く
- 水は材料に含めない（手順に書く）
- steps は3〜7手順で、各手順は簡潔に
- 料理名は具体的に（例:「鶏むね肉のねぎ塩焼き」）`;

function storageText(i, storage) {
  return storage === '冷凍'
    ? `冷凍保存（調理後${i + 1}日目に解凍して食べる）`
    : `冷蔵保存（調理後${i + 1}日目に食べる）`;
}

export function weekPrompt({ settings, members, prefs, pantry, days, mainRequests, sideRequests, fixedNames = [], avoidNames = [], extraRequest = '' }) {
  const lines = [];
  lines.push(commonContext({ settings, members, prefs, pantry }));
  if (fixedNames.length) lines.push(`\n# 今週すでに決まっている料理（重複・似た料理を避ける）\n${fixedNames.join('、')}`);
  if (avoidNames.length) lines.push(`\n# 提案しないでほしい料理\n${avoidNames.join('、')}`);
  if (extraRequest.trim()) lines.push(`\n# 今回の要望\n${extraRequest.trim()}`);

  lines.push('\n# 作ってほしい料理');
  lines.push(`## 主菜 mains（${mainRequests.length}品）— この順番で、slot に番号を入れて返す`);
  if (!mainRequests.length) lines.push('（なし。空配列を返す）');
  mainRequests.forEach((r, i) => {
    const d = days[r.day];
    const who = dayServings(members, d.absent);
    lines.push(`- slot=${i}: ${mdw(d.date)} ／ 主食材: ${r.target ? r.target.label : 'おまかせ'} ／ ${storageText(r.day, r.storage)} ／ この日は${who}人分`);
  });
  lines.push(`## 副菜 sides（${sideRequests.length}品）— この順番で、slot に番号を入れて返す`);
  if (!sideRequests.length) lines.push('（なし。空配列を返す）');
  sideRequests.forEach((r, i) => {
    const d = days[r.day];
    lines.push(`- slot=${i}: ${mdw(d.date)} ／ 野菜中心の副菜 ／ ${storageText(r.day, r.storage)}`);
  });
  lines.push('\n副菜は、同じ日の主菜と味付け・色味が重ならないように選ぶ。複数の料理で同じ野菜を使い回して買い物の品数を減らす工夫をする。');
  lines.push('\n' + RULES);
  return lines.join('\n');
}

export function namedRecipePrompt({ settings, members, prefs, pantry, name, type }) {
  return `${commonContext({ settings, members, prefs, pantry })}

# 依頼
「${name}」の${type === 'main' ? '主菜' : '副菜'}レシピを1つ、作り置き向けに書いてください。slot は 0。

${RULES}`;
}

export function prepPrompt({ settings, members, dishes }) {
  const list = dishes
    .map((d) => `- ${d.dayLabel} ${d.type === 'main' ? '主菜' : '副菜'}「${d.name}」 ${d.servings}人分 ／ ${d.storage}保存\n  材料: ${d.ingredients}\n  手順: ${d.steps}`)
    .join('\n');
  return `あなたは作り置きの段取りに詳しい家事のプロです。
共働き家庭が日曜日に平日5日分の夕食をまとめて作ります。家族: ${familyText(members)}。
家庭用キッチン（コンロ2〜3口、電子レンジ、魚焼きグリルまたはトースター）を想定し、
下の料理を最短時間で作るための「段取り」を考えてください。

# 作る料理
${list}

# 条件
- 同じ野菜のカットや下ゆでは料理をまたいでまとめる
- 煮込み中に別の料理を進めるなど、並行作業を具体的に書く
- 子ども向けの取り分けが必要なタイミングも手順に含める
- 最後に、冷ます・容器に詰める・曜日ラベル・冷凍と解凍のタイミングの指示を入れる
- steps は6〜12個、detail には対象の料理名を入れる
- tips には衛生面や時短のコツを2〜4個
${settings.notes?.trim() ? `- 家庭の要望: ${settings.notes.trim()}` : ''}`;
}
