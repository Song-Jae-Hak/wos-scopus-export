/**
 * Scopus 논문 EID 반출 도우미 — 서버 쪽
 *
 *   POST /scopus/api/search       Scopus Search API 프록시 (X-ELS-APIKey 헤더는 서버에서만 붙임)
 *   GET  /scopus/api/settings     저장된 설정(저장 폴더·자르는 개수·쿼리 템플릿 등)
 *   POST /scopus/api/settings
 *   POST /scopus/api/pick-folder  윈도우 폴더 선택 창을 띄워서 경로를 돌려줌
 *   POST /scopus/api/open-folder  탐색기로 폴더 열기
 *   POST /scopus/api/save         EID 목록을 N개씩 잘라 폴더에 엑셀/CSV로 저장
 *
 * 브라우저는 폴더의 전체 경로를 알 수 없고 기억도 못 하므로, 저장은 이 로컬 서버가 한다.
 * 설정은 features/scopus/data/settings.json 에 남는다 (.gitignore 처리).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { settingsStore, folderRoutes, safeFileName, uniquePath } = require('../../lib/local-files');

const router = express.Router();

const SEARCH_URL = 'https://api.elsevier.com/content/search/scopus';
const store = settingsStore(__dirname);
const readSettings = () => store.read();
const writeSettings = (patch) => store.write(patch);

// Scopus 내보내기(CSV) 양식과 같은 열 순서. 지금은 EID만 채우고 나머지는 빈칸.
const EXPORT_COLUMNS = [
  'Authors', 'Author(s) ID', 'Title', 'Year', 'Source title', 'Volume', 'Issue', 'Art. No.',
  'Page start', 'Page end', 'Page count', 'Cited by', 'DOI', 'Link', 'Affiliations',
  'Authors with affiliations', 'Abstract', 'Author Keywords', 'Funding Text 1', 'Funding Text 2',
  'Publisher', 'ISSN', 'ISBN', 'CODEN', 'Document Type', 'Publication Stage', 'Open Access',
  'Source', 'EID',
];

function apiKey(override) {
  const k = String(override || process.env.SCOPUS_API_KEY || '').trim();
  return k.includes('여기에') ? '' : k;
}

// ───────── Scopus 검색 프록시 ─────────

router.post('/search', async (req, res) => {
  const { query, start = 0, count = 25, fields, tempKey } = req.body || {};
  const key = apiKey(tempKey);
  if (!key) {
    return res.json({ ok: false, error: 'SCOPUS_API_KEY가 없습니다. .env 에 키를 넣고 서버를 다시 켜거나, 화면에서 임시 키를 입력하세요.' });
  }
  if (!query || !String(query).trim()) return res.json({ ok: false, error: 'query가 비어 있습니다.' });

  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', String(query));
  url.searchParams.set('count', String(count));
  url.searchParams.set('start', String(start));
  if (fields) url.searchParams.set('field', String(fields));

  const started = Date.now();
  try {
    const upstream = await fetch(url, { headers: { 'X-ELS-APIKey': key, Accept: 'application/json' } });
    const text = await upstream.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    res.json({
      ok: upstream.ok,
      status: upstream.status,
      body,
      elapsedMs: Date.now() - started,
      rateLimit: {
        limit: upstream.headers.get('x-ratelimit-limit'),
        remaining: upstream.headers.get('x-ratelimit-remaining'),
        reset: upstream.headers.get('x-ratelimit-reset'),
      },
      // 화면의 "요청 URL" 표시용. 키는 헤더로만 가므로 URL에 없다.
      requestUrl: url.toString(),
    });
  } catch (err) {
    res.json({ ok: false, error: `Scopus API 요청 실패: ${err.message}`, elapsedMs: Date.now() - started });
  }
});

// ───────── 설정 ─────────

router.get('/settings', (req, res) => {
  const s = readSettings();
  const key = apiKey();
  res.json({
    ...s,
    hasKey: Boolean(key),
    keyPreview: key ? key.slice(0, 4) + '…' + key.slice(-4) + ` (${key.length}자)` : '',
    folderExists: s.folder ? fs.existsSync(s.folder) : false,
    columns: EXPORT_COLUMNS,
  });
});

router.post('/settings', (req, res) => {
  const allowed = ['folder', 'chunkSize', 'format', 'template', 'count', 'splitByStage', 'startDate', 'endDate'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  res.json(writeSettings(patch));
});

// ───────── 폴더 선택 / 열기 (공통: lib/local-files.js) ─────────

folderRoutes(router, store, { description: 'Scopus EID 엑셀을 저장할 폴더를 고르세요' });

// ───────── 잘라서 저장 ─────────
// Scopus 내보내기 CSV처럼 모든 칸을 큰따옴표로 감싼다 (빈칸도 "")
function csvCell(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

async function writeChunk(file, eids, format) {
  const eidIdx = EXPORT_COLUMNS.indexOf('EID');
  const rows = eids.map((eid) => EXPORT_COLUMNS.map((_, i) => (i === eidIdx ? eid : '')));
  if (format === 'csv') {
    // Excel에서 한글/UTF-8이 깨지지 않게 BOM 포함
    const text = [EXPORT_COLUMNS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    fs.writeFileSync(file, '﻿' + text, 'utf8');
    return;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(EXPORT_COLUMNS);
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  EXPORT_COLUMNS.forEach((c, i) => { ws.getColumn(i + 1).width = c === 'EID' ? 24 : Math.max(10, c.length + 2); });
  await wb.xlsx.writeFile(file);
}

router.post('/save', async (req, res) => {
  const { folder, chunkSize, format = 'csv', baseName, groups } = req.body || {};
  const size = Math.floor(Number(chunkSize));
  if (!folder) return res.json({ ok: false, error: '저장 폴더를 지정해 주세요.' });
  if (!(size >= 1)) return res.json({ ok: false, error: '자르는 개수는 1 이상이어야 합니다.' });
  if (!Array.isArray(groups) || !groups.some((g) => g.eids && g.eids.length)) {
    return res.json({ ok: false, error: '저장할 EID가 없습니다.' });
  }
  const ext = format === 'csv' ? '.csv' : '.xlsx';
  const safeBase = safeFileName(baseName) || 'Scopus_EID';

  try {
    fs.mkdirSync(folder, { recursive: true });
    const written = [];
    for (const g of groups) {
      const eids = (g.eids || []).filter(Boolean);
      const parts = Math.ceil(eids.length / size);
      const digits = Math.max(2, String(parts).length);
      for (let p = 0; p < parts; p++) {
        const slice = eids.slice(p * size, (p + 1) * size);
        const label = g.label ? `_${safeFileName(g.label)}` : '';
        const file = uniquePath(folder, `${safeBase}${label}_${String(p + 1).padStart(digits, '0')}`, ext);
        await writeChunk(file, slice, format);
        written.push({ file: path.basename(file), count: slice.length, group: g.label || '' });
      }
    }
    writeSettings({ folder, chunkSize: size, format });
    res.json({ ok: true, folder, files: written });
  } catch (err) {
    res.json({ ok: false, error: `저장 실패: ${err.message}` });
  }
});

module.exports = router;
