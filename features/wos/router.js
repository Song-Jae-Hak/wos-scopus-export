/**
 * Web of Science 논문 반출 — 서버 쪽
 *
 *   GET  /wos/api/settings      저장된 쿼리·기간·폴더 등 + 크롬 버전 정보
 *   POST /wos/api/settings
 *   POST /wos/api/pick-folder   /  POST /wos/api/open-folder   (lib/local-files.js)
 *   POST /wos/api/run           반출 시작 (한 번에 하나만)
 *   GET  /wos/api/job           진행 상황·로그·결과 (화면이 1초마다 조회)
 *   POST /wos/api/cancel        중지
 *
 * 받은 Excel(1000건 단위)을 하나로 합치고 맨 앞에 "RG" 열(받은 날짜 YYYYMMDD)을 붙여 저장 폴더에 쓴다.
 * 작업용 파일: data/chrome-profile (자동화 크롬 프로필: 쿠키·로그인 유지), data/downloads (받는 중 임시 파일)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { settingsStore, folderRoutes, safeFileName, uniquePath } = require('../../lib/local-files');
const { runExport, targetBrowserVersion, toDashed, Cancelled } = require('./wos-export');

const router = express.Router();
const store = settingsStore(__dirname);
const DATA_DIR = path.join(__dirname, 'data');

const DEFAULT_QUERY =
  '(CU=SOUTH KOREA AND (AD=(PUSAN-NATL-UNIV* OR BUSAN-NATL-UNIV* OR PNU OR PUSAN-UNIV* OR BUSAN-UNIV*  OR PUSAN NATL BUSAN* OR PUSAN-NATIONAL-UNIVERSITY*) ' +
  'NOT (AD=(BUSAN-NATL-UNIV-EDUC OR PUSAN-UNIV-FOREIGN* OR BUSAN-UNIV-FOREIGN* OR PRINCESS NOURAH BINT ABDULRAHMAN UNIVERSITY )))) ' +
  'AND ((EDN==("WOS.SCI" OR "WOS.SSCI" OR "WOS.AHCI")) NOT (DT==("MEETING ABSTRACT")))';

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const hms = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

// ───────── 설정 ─────────

router.get('/settings', async (req, res) => {
  const s = store.read();
  let chromeInfo = null;
  try { chromeInfo = await targetBrowserVersion(); } catch (err) { chromeInfo = { error: err.message }; }
  res.json({
    query: s.query || DEFAULT_QUERY,
    defaultQuery: DEFAULT_QUERY,
    startDate: s.startDate || '',
    endDate: s.endDate || '',
    folder: s.folder || '',
    folderExists: s.folder ? fs.existsSync(s.folder) : false,
    headless: !!s.headless,
    slowFactor: Number(s.slowFactor) || 1,
    chrome: chromeInfo,
  });
});

router.post('/settings', (req, res) => {
  const allowed = ['query', 'startDate', 'endDate', 'folder', 'headless', 'slowFactor'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  res.json(store.write(patch));
});

folderRoutes(router, store, { description: 'Web of Science 반출 엑셀을 저장할 폴더를 고르세요' });

// ───────── 작업 ─────────

let job = null; // 현재(또는 마지막) 작업

function newJob() {
  return {
    id: Date.now().toString(36),
    state: 'running', // running | done | error | cancelled
    progress: 0,
    text: '시작 중…',
    log: [],
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    cancelRequested: false,
    driver: null,
  };
}

function publicJob(j) {
  if (!j) return null;
  const { driver, cancelRequested, ...rest } = j;
  return rest;
}

router.get('/job', (req, res) => res.json(publicJob(job)));

router.post('/cancel', async (req, res) => {
  if (!job || job.state !== 'running') return res.json({ ok: false, error: '실행 중인 작업이 없습니다.' });
  job.cancelRequested = true;
  job.log.push({ t: hms(), msg: '중지 요청… 자동화 크롬을 닫습니다.', level: 'w' });
  // 기다리는 중인 Selenium 호출을 바로 끊기 위해 브라우저를 닫는다
  if (job.driver) job.driver.quit().catch(() => {});
  res.json({ ok: true });
});

router.post('/run', (req, res) => {
  if (job && job.state === 'running') return res.json({ ok: false, error: '이미 반출 작업이 실행 중입니다.' });
  const { query, startDate, endDate, folder, fileName, headless } = req.body || {};
  const slowFactor = Math.max(1, Math.min(3, Number((req.body || {}).slowFactor) || 1));
  try {
    toDashed(startDate); toDashed(endDate);
    if (endDate < startDate) throw new Error('마지막일이 시작일보다 빠릅니다.');
    if (!query || !String(query).trim()) throw new Error('쿼리가 비어 있습니다.');
    if (!folder || !String(folder).trim()) throw new Error('저장 폴더를 지정해 주세요.');
    // 반출이 다 끝난 뒤에 저장이 실패하지 않도록 먼저 확인
    if (!path.isAbsolute(String(folder).trim())) throw new Error(`저장 폴더는 전체 경로로 입력해 주세요 (예: C:\\Users\\...\\WoS 반출): ${folder}`);
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
  store.write({ query: String(query).trim(), startDate, endDate, folder: String(folder).trim(), headless: !!headless, slowFactor });

  job = newJob();
  const j = job;
  const log = (msg, level) => j.log.push({ t: hms(), msg, level: level || '' });
  const progress = (pct, text) => { j.progress = pct; if (text) j.text = text; };

  (async () => {
    const downloadDir = path.join(DATA_DIR, 'downloads', j.id);
    try {
      const { total, files } = await runExport({
        query: String(query).trim(), startDate, endDate, headless: !!headless, slowFactor,
        downloadDir, profileDir: path.join(DATA_DIR, 'chrome-profile'),
        log, progress, isCancelled: () => j.cancelRequested, onDriver: (d) => { j.driver = d; },
      });
      if (j.cancelRequested) throw new Cancelled();
      if (!total) {
        j.result = { total: 0, rows: 0, parts: 0 };
        j.state = 'done'; j.progress = 100; j.text = '검색 결과가 없습니다.';
        log('검색 결과가 없어 저장할 파일이 없습니다.', 'w');
        return;
      }
      progress(93, '받은 파일 합치는 중…');
      const rg = ymd();
      const merged = mergeWithRG(files, rg);
      const base = safeFileName(fileName) || `WoS_${startDate}-${endDate}_${rg}`;
      fs.mkdirSync(folder, { recursive: true });
      const out = uniquePath(folder, base.replace(/\.xlsx?$/i, ''), '.xlsx');
      await writeXlsx(out, merged);
      if (merged.rows.length !== total) {
        log(`[확인 필요] 검색 결과는 ${total}건인데 받은 행은 ${merged.rows.length}건입니다.`, 'w');
      }
      j.result = { total, parts: files.length, rows: merged.rows.length, columns: merged.columns.length, rg, file: path.basename(out), fullPath: out, folder };
      j.state = 'done'; j.progress = 100; j.text = '완료';
      log(`저장 완료: ${out} (${merged.rows.length.toLocaleString('ko-KR')}행, RG=${rg})`);
    } catch (err) {
      const cancelled = err instanceof Cancelled || j.cancelRequested;
      j.state = cancelled ? 'cancelled' : 'error';
      j.error = cancelled ? '사용자가 중지했습니다.' : err.message;
      j.text = cancelled ? '중지됨' : '오류';
      log(cancelled ? '중지했습니다.' : `[오류] ${err.message}`, cancelled ? 'w' : 'e');
    } finally {
      j.driver = null;
      fs.rm(downloadDir, { recursive: true, force: true }, () => {});
    }
  })();

  res.json({ ok: true, id: j.id });
});

// ───────── 합치기 + RG 열 ─────────

/** 받은 엑셀들을 순서대로 이어 붙이고 맨 앞에 RG 열 추가. 머리행이 다르면 이름 기준으로 맞춘다. */
function mergeWithRG(files, rg) {
  let columns = null;
  const rows = [];
  for (const f of files) {
    const wb = XLSX.readFile(f, { cellDates: true, dense: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    if (!aoa.length) continue;
    const header = aoa[0].map((h) => String(h ?? '').trim());
    if (!columns) columns = header;
    const idx = columns.map((c) => header.indexOf(c));
    for (let i = 1; i < aoa.length; i++) {
      const src = aoa[i];
      if (!src.some((v) => v !== null && v !== '')) continue;
      rows.push([rg, ...idx.map((k) => (k >= 0 && src[k] !== undefined ? src[k] : null))]);
    }
  }
  return { columns: ['RG', ...(columns || [])], rows };
}

async function writeXlsx(file, { columns, rows }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('savedrecs', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(columns);
  for (const r of rows) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  columns.forEach((c, i) => {
    let w = String(c).length;
    for (let k = 0; k < Math.min(rows.length, 200); k++) {
      const v = rows[k][i];
      if (v !== null && v !== undefined) w = Math.max(w, Math.min(String(v).length, 60));
    }
    ws.getColumn(i + 1).width = Math.min(Math.max(w + 2, 8), 50);
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  await wb.xlsx.writeFile(file);
}

module.exports = router;
module.exports._test = { mergeWithRG, writeXlsx };
