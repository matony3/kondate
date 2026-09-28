// Google AI Studio (Gemini API) クライアント。ブラウザから直接呼び出す。
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function apiError(res) {
  let msg = res.statusText;
  try {
    const j = await res.json();
    msg = j.error?.message || msg;
  } catch { /* 本文なし */ }
  const hint = res.status === 400 && /API key/i.test(msg) ? '（APIキーを確認してください）'
    : res.status === 429 ? '（利用上限に達しました。しばらく待つか別のモデルを試してください）'
    : res.status === 404 ? '（モデル名を確認してください）' : '';
  return new Error(`Gemini API エラー ${res.status}: ${msg}${hint}`);
}

export async function generateJSON({ apiKey, model, prompt, schema, temperature = 0.9 }) {
  if (!apiKey) throw new Error('Gemini APIキーが設定されていません');
  const name = String(model || 'gemini-2.5-flash').replace(/^models\//, '');
  const res = await fetch(`${BASE}/models/${encodeURIComponent(name)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
    }),
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const reason = data.promptFeedback?.blockReason || cand?.finishReason || '不明';
    throw new Error(`Gemini から回答が得られませんでした（理由: ${reason}）`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini の回答を読み取れませんでした（JSON 形式エラー）。もう一度お試しください');
  }
}

export async function listModels(apiKey) {
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /gemini/i.test(n));
}
