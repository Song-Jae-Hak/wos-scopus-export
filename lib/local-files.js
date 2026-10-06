/**
 * 기능들이 같이 쓰는 로컬 파일 도우미 (이 PC에서 도는 허브 서버 전용)
 *
 *   settingsStore(dir)        features/<id>/data/settings.json 읽기/쓰기
 *   folderRoutes(router, s)   POST pick-folder / open-folder 라우트를 붙여 줌 (고른 폴더는 settings.folder 에 저장)
 *   uniquePath(dir, base, ext) 같은 이름 파일이 있으면 "이름 (2).xlsx" 처럼 겹치지 않는 경로
 *   safeFileName(name)        윈도우 파일명에 못 쓰는 문자를 _ 로
 *
 * 브라우저는 폴더의 전체 경로를 알 수도, 기억할 수도 없어서 "지정 폴더에 저장"은 서버가 맡는다.
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

function settingsStore(featureDir) {
  const dataDir = path.join(featureDir, 'data');
  const file = path.join(dataDir, 'settings.json');
  return {
    read() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
    },
    write(patch) {
      const next = { ...this.read(), ...patch, updatedAt: new Date().toISOString() };
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
      return next;
    },
  };
}

const PICK_FOLDER_SCRIPT = path.join(__dirname, 'pick-folder.ps1');
let pickerOpen = null; // 창이 이미 떠 있으면 새로 띄우지 않고 같은 결과를 기다림 (버튼 연타 방지)

/**
 * 윈도우 폴더 선택 창 (탐색기 스타일, 항상 맨 앞). 취소하면 ''.
 * 설명·초기 경로는 환경변수로 넘긴다 — 한글/따옴표가 명령줄에서 깨지지 않게. 자세한 이유는 pick-folder.ps1 머리말.
 */
function pickFolder({ initial = '', description = '저장할 폴더를 고르세요' } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('폴더 선택 창은 윈도우에서만 지원합니다. 경로를 직접 입력하세요.'));
  if (pickerOpen) return pickerOpen;
  pickerOpen = new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PICK_FOLDER_SCRIPT],
      { env: { ...process.env, WA_INITIAL: initial, WA_DESC: description }, windowsHide: true, timeout: 10 * 60 * 1000, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())));
  }).finally(() => { pickerOpen = null; });
  return pickerOpen;
}

function folderRoutes(router, store, { description } = {}) {
  router.post('/pick-folder', async (req, res) => {
    const initial = String((req.body && req.body.initial) || store.read().folder || '');
    try {
      const picked = await pickFolder({ initial, description });
      if (!picked) return res.json({ ok: false, cancelled: true });
      store.write({ folder: picked });
      res.json({ ok: true, folder: picked });
    } catch (err) {
      res.json({ ok: false, error: `폴더 선택 창을 열지 못했습니다: ${err.message}` });
    }
  });

  router.post('/open-folder', (req, res) => {
    const folder = String((req.body && req.body.folder) || store.read().folder || '');
    if (!folder || !fs.existsSync(folder)) return res.json({ ok: false, error: '폴더가 없습니다.' });
    spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  });
}

const INVALID_NAME = /[\\/:*?"<>|\x00-\x1f]/g;
function safeFileName(name) { return String(name || '').replace(INVALID_NAME, '_').trim(); }

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

module.exports = { settingsStore, pickFolder, folderRoutes, safeFileName, uniquePath };
