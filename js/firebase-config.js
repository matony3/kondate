// Firebase の設定（Firebase コンソール → プロジェクトの設定 → マイアプリ → 「SDK の設定と構成」の値）
// ここに書くと、家族の全端末で貼り付け不要になります。これらの値は公開されても問題ない情報です
// （データはセキュリティルール（firestore.rules）で家族だけが読み書きできるよう守られます）。
export const firebaseConfig = null;
// 例:
// export const firebaseConfig = {
//   apiKey: 'AIza...',
//   authDomain: 'your-project.firebaseapp.com',
//   projectId: 'your-project',
//   appId: '1:1234567890:web:abcdef',
// };
