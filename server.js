/**
 * WoS · Scopus 반출 도구 서버
 *
 *   node server.js  ->  http://localhost:4100
 *
 * features/<id>/ 폴더를 자동으로 찾아서 붙인다. 새 기능을 추가할 때 이 파일은 고칠 필요 없음.
 *   features/<id>/feature.json   카드에 표시할 정보 (필수)
 *   features/<id>/public/        화면 파일. /<id>/ 로 서빙됨 (필수)
 *   features/<id>/router.js      서버 API가 필요할 때만. /<id>/api/ 아래에 붙음 (선택)
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4100);
const FEATURES_DIR = path.join(__dirname, 'features');

const app = express();
app.use(express.json({ limit: '1mb' }));

// .env 값이 비었거나 placeholder(여기에_...)면 설정 안 된 것으로 본다
function envReady(key) {
  const v = (process.env[key] || '').trim();
  return v !== '' && !v.includes('여기에');
}

function loadFeatures() {
  const list = [];
  for (const id of fs.readdirSync(FEATURES_DIR)) {
    const dir = path.join(FEATURES_DIR, id);
    const metaFile = path.join(dir, 'feature.json');
    if (!fs.existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      list.push({ ...meta, id, dir });
    } catch (err) {
      console.error(`  [경고] ${id}/feature.json 읽기 실패: ${err.message}`);
    }
  }
  return list.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

const features = loadFeatures();

for (const f of features) {
  const routerFile = path.join(f.dir, 'router.js');
  if (fs.existsSync(routerFile)) {
    app.use(`/${f.id}/api`, require(routerFile));
  }
  app.use(`/${f.id}`, express.static(path.join(f.dir, 'public'), { etag: false, maxAge: 0 }));
}

// 홈 화면 구역 (features/groups.json). feature.json 의 "group" 이 여기 없는 이름이면 "기타" 구역에 들어간다.
function loadGroups() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FEATURES_DIR, 'groups.json'), 'utf8'));
  } catch (err) {
    console.error(`  [경고] features/groups.json 읽기 실패: ${err.message}`);
    return [];
  }
}
const groups = loadGroups();
const OTHER_GROUP = { id: '기타', title: '기타', description: '', order: 9999 };

app.get('/api/features', (req, res) => {
  const known = new Set(groups.map((g) => g.id));
  const list = features.map(({ dir, requiresEnv = [], ...meta }) => {
    const missing = requiresEnv.filter((k) => !envReady(k));
    const group = known.has(meta.group) ? meta.group : OTHER_GROUP.id;
    return { ...meta, group, href: `/${meta.id}/`, ready: missing.length === 0, missingEnv: missing };
  });
  const used = new Set(list.map((f) => f.group));
  res.json({
    groups: [...groups, OTHER_GROUP].filter((g) => used.has(g.id)).sort((a, b) => (a.order ?? 999) - (b.order ?? 999)),
    features: list,
  });
});

// 홈의 "자주 쓰는 기능" — 사용자가 카드의 ☆ 로 고른 기능 id 목록 (고른 순서). 브라우저가 아니라 여기 저장해서
// 브라우저 기록을 지우거나 다른 브라우저로 열어도 유지된다.
const FAVORITES_FILE = path.join(__dirname, 'data', 'favorites.json');
function readFavorites() {
  try { return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8')).filter((id) => typeof id === 'string'); } catch { return []; }
}
app.get('/api/favorites', (req, res) => res.json(readFavorites()));
app.post('/api/favorites', (req, res) => {
  const ids = Array.isArray(req.body) ? req.body : [];
  const valid = new Set(features.map((f) => f.id));
  const clean = [...new Set(ids.filter((id) => valid.has(id)))];
  fs.mkdirSync(path.dirname(FAVORITES_FILE), { recursive: true });
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(clean, null, 2), 'utf8');
  res.json(clean);
});

// 브라우저에서 엑셀을 읽고 쓰는 기능용 라이브러리 (CDN 없이 오프라인에서도 동작)
app.get('/vendor/xlsx.full.min.js', (req, res) =>
  res.sendFile(require.resolve('xlsx/dist/xlsx.full.min.js'))
);
app.get('/vendor/exceljs.min.js', (req, res) =>
  res.sendFile(require.resolve('exceljs/dist/exceljs.min.js'))
);

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// 이 PC에서만 접속 가능 (파일 저장·폴더 선택 창 같은 로컬 전용 API가 있으므로 외부에 열지 않는다)
app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  WoS · Scopus 반출 도구');
  console.log('  ─────────────────────────────────────────────');
  console.log('  화면 : http://localhost:' + PORT);
  for (const f of features) {
    const missing = (f.requiresEnv || []).filter((k) => !envReady(k));
    const state = missing.length ? `  (.env 필요: ${missing.join(', ')})` : '';
    console.log(`   - ${f.title.padEnd(18)} /${f.id}/${state}`);
  }
  console.log('');
  console.log('  창을 닫거나 Ctrl+C 를 누르면 서버가 종료됩니다.');
  console.log('');
});
