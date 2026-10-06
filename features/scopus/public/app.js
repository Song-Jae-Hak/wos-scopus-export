/*
 * Scopus 논문 EID 반출 도우미 — 화면 쪽
 *
 * 흐름: 기간(YYYYMMDD) → epoch 변환 → 쿼리 템플릿에 {STAGE}/{START}/{END} 채움
 *       → PUBSTAGE "Final", "aip" 를 각각 페이지 단위로 호출해 EID 수집
 *       → 서버가 Scopus 내보내기 양식(29열, EID만 채움)으로 N개씩 잘라 폴더에 저장
 */
(() => {
'use strict';

const DEFAULT_TEMPLATE =
  '((AF-ID(60008783) OR AF-ID(60004269) OR AF-ID(60211908) OR AF-ID(60212157) OR AF-ID(60212010) OR AF-ID(60211571) OR AF-ID(60211961)) OR AF-ID(113482684) ) ' +
  'AND PUBSTAGE( "{STAGE}" ) AND ORIG-LOAD-DATE AFT {START} AND ORIG-LOAD-DATE BEF {END} AND PUBYEAR AFT 2017';
const STAGES = [
  { key: 'final', value: 'Final', label: 'Final' },
  { key: 'aip', value: 'aip', label: 'Article in Press' },
];
// 미리보기용으로 몇 개 필드만 받는다 (응답이 작아져서 빠름). 저장되는 건 EID뿐.
const FIELDS = 'eid,dc:title,prism:publicationName,prism:coverDate,subtypeDescription';
const OFFSET_LIMIT = 5000; // Scopus Search API: start+count 는 5000을 넘을 수 없음
const PREVIEW_ROWS = 200;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (n) => Number(n).toLocaleString('ko-KR');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let settings = {};
let result = null;     // { final: [...], aip: [...] }  각 항목 {eid,title,source,date,type}
let previewTab = 'all';
let stopRequested = false;
let baseNameTouched = false;

// ───────── 날짜 ─────────

function ymd(d) { return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; }

/** YYYYMMDD → 이 PC 시간대 기준 unix 초. endOfDay 면 23:59:59 (원본 파이썬 yyyymmdd_to_unix 와 동일) */
function yyyymmddToUnix(s, endOfDay = false) {
  if (!/^\d{8}$/.test(s)) throw new Error('날짜 형식은 YYYYMMDD 로 입력해 주세요.');
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw new Error(`없는 날짜입니다: ${s}`);
  return Math.floor(dt.getTime() / 1000);
}
function unixLabel(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function quickRange(kind) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const yest = new Date(t); yest.setDate(t.getDate() - 1);
  if (kind === 'w1' || kind === 'w2') {
    const s = new Date(t); s.setDate(t.getDate() - (kind === 'w1' ? 7 : 14));
    return [s, yest];
  }
  if (kind === 'lastMonth') return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)];
  if (kind === 'thisMonth') return [new Date(t.getFullYear(), t.getMonth(), 1), yest < new Date(t.getFullYear(), t.getMonth(), 1) ? t : yest];
  // half: 직전에 끝난 반월 (오늘이 16일 이후면 이번 달 1~15일, 아니면 지난달 16~말일)
  if (t.getDate() > 15) return [new Date(t.getFullYear(), t.getMonth(), 1), new Date(t.getFullYear(), t.getMonth(), 15)];
  return [new Date(t.getFullYear(), t.getMonth() - 1, 16), new Date(t.getFullYear(), t.getMonth(), 0)];
}

// ───────── 쿼리 ─────────

function buildQueries() {
  const s = $('#startDate').value.trim(), e = $('#endDate').value.trim();
  const start = yyyymmddToUnix(s), end = yyyymmddToUnix(e, true);
  if (end < start) throw new Error('마지막일이 시작일보다 빠릅니다.');
  const tpl = $('#template').value.trim();
  const fill = (stage) => tpl.replaceAll('{STAGE}', stage).replaceAll('{START}', start).replaceAll('{END}', end);
  return { start, end, final: fill('Final'), aip: fill('aip') };
}

function refreshQueryPreview() {
  const tpl = $('#template').value;
  const missing = ['{STAGE}', '{START}', '{END}'].filter((p) => !tpl.includes(p));
  $('#tplWarn').textContent = missing.length ? `⚠ 템플릿에 ${missing.join(' ')} 가 없습니다` : '';
  $('#tplWarn').style.color = missing.length ? 'var(--warn)' : '';
  try {
    const q = buildQueries();
    $('#epoch').innerHTML = `AFT <b>${q.start}</b> (${unixLabel(q.start)}) · BEF <b>${q.end}</b> (${unixLabel(q.end)})`;
    $('#qFinal').textContent = q.final;
    $('#qAip').textContent = q.aip;
  } catch (err) {
    $('#epoch').innerHTML = `<span style="color:var(--err)">${esc(err.message)}</span>`;
    $('#qFinal').textContent = $('#qAip').textContent = '—';
  }
  if (!baseNameTouched) $('#baseName').value = defaultBaseName();
}

function defaultBaseName() {
  const s = $('#startDate').value.trim(), e = $('#endDate').value.trim();
  return `Scopus_EID_${s || 'start'}-${e || 'end'}`;
}

// ───────── 화면 헬퍼 ─────────

function log(msg, level) {
  const el = $('#log');
  const d = new Date();
  const line = document.createElement('span');
  if (level) line.className = level;
  line.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}  ${msg}\n`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function setProgress(v, text) {
  $('#bar').style.width = Math.max(0, Math.min(100, v)) + '%';
  if (text !== undefined) $('#statusLine').textContent = text;
}
async function api(path, body) {
  const r = await fetch('api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
function saveSettings(patch) { return api('settings', patch).then((s) => { settings = { ...settings, ...s }; }); }

/** Scopus 오류 응답에서 사람이 읽을 메시지 꺼내기 */
function scopusError(res) {
  if (res.error) return res.error;
  const b = res.body || {};
  const se = b['service-error'] && b['service-error'].status;
  const er = b['error-response'];
  const msg = se ? `${se.statusCode}: ${se.statusText}`
    : er ? `${er['error-code'] || ''}: ${er['error-message'] || JSON.stringify(er)}`
    : (typeof b === 'string' ? b.slice(0, 200) : '');
  const hint = res.status === 401 ? ' — API 키가 잘못되었거나 권한이 없습니다.'
    : res.status === 403 ? ' — 이 키/IP로는 접근할 수 없습니다 (교내망 또는 기관 인증 필요할 수 있음).'
    : res.status === 429 ? ' — 호출 한도를 넘었습니다. 잠시 후 다시 시도하세요.'
    : res.status === 400 ? ' — 쿼리 문법 또는 count 값을 확인하세요.' : '';
  return `HTTP ${res.status} ${msg}${hint}`;
}

// ───────── 불러오기 ─────────

async function fetchStage(stage, query, count, onPage) {
  const items = [];
  let start = 0, total = null, truncated = false;
  while (true) {
    if (stopRequested) throw new Error('사용자가 중지했습니다.');
    const res = await api('search', { query, start, count, fields: FIELDS, tempKey: $('#tempKey').value.trim() });
    if (!res.ok) throw new Error(`[${stage.value}] ${scopusError(res)}`);
    const sr = res.body['search-results'] || {};
    total = Number(sr['opensearch:totalResults'] || 0);
    for (const e of sr.entry || []) {
      if (!e.eid) continue; // 결과 0건이면 {"error":"Result set was empty"} 한 줄이 옴
      items.push({ eid: e.eid, title: e['dc:title'] || '', source: e['prism:publicationName'] || '', date: e['prism:coverDate'] || '', type: e.subtypeDescription || '', stage: stage.key });
    }
    start += count;
    onPage(items.length, total);
    if (start >= total || !(sr.entry || []).some((e) => e.eid)) break;
    if (start >= OFFSET_LIMIT) { truncated = true; break; }
    await sleep(150); // 초당 호출 한도 여유
  }
  return { items, total, truncated };
}

async function runFetch() {
  let q;
  try { q = buildQueries(); } catch (err) { alert(err.message); return; }
  const count = Math.max(1, Math.min(200, Math.floor(Number($('#count').value) || 25)));
  $('#count').value = count;
  stopRequested = false;
  $('#btnFetch').disabled = true; $('#btnStop').disabled = false; $('#btnSaveFiles').disabled = true;
  saveSettings({ template: $('#template').value.trim(), count, startDate: $('#startDate').value.trim(), endDate: $('#endDate').value.trim() });

  const got = {};
  try {
    for (let i = 0; i < STAGES.length; i++) {
      const st = STAGES[i];
      log(`PUBSTAGE "${st.value}" 불러오는 중…`);
      const r = await fetchStage(st, q[st.key], count, (n, total) => {
        const frac = total ? n / Math.min(total, OFFSET_LIMIT) : 1;
        setProgress(((i + frac) / STAGES.length) * 100, `${st.label}: ${fmt(n)} / ${fmt(total)}건`);
      });
      got[st.key] = r.items;
      log(`${st.label}: 전체 ${fmt(r.total)}건 중 ${fmt(r.items.length)}건 수집`);
      if (r.truncated) log(`[주의] ${st.label} 결과가 ${fmt(OFFSET_LIMIT)}건을 넘어 앞 ${fmt(OFFSET_LIMIT)}건만 가져왔습니다. 기간을 나눠서 불러오세요.`, 'w');
    }
    result = got;
    setProgress(100, '완료');
    renderResult();
    $('#btnSaveFiles').disabled = false;
  } catch (err) {
    setProgress(0, '');
    log(`[오류] ${err.message}`, 'e');
    if (!/중지/.test(err.message)) alert(err.message);
  } finally {
    $('#btnFetch').disabled = false; $('#btnStop').disabled = true;
  }
}

/** 합쳐서 저장할 때의 목록: Final 먼저, 그다음 aip. 같은 EID는 한 번만. */
function combined() {
  const seen = new Set();
  return [...result.final, ...result.aip].filter((x) => (seen.has(x.eid) ? false : (seen.add(x.eid), true)));
}

function renderResult() {
  const all = combined();
  const chunk = Math.max(1, Math.floor(Number($('#chunk').value) || 40));
  const split = $('#splitByStage').checked;
  const files = split
    ? Math.ceil(result.final.length / chunk) + Math.ceil(result.aip.length / chunk)
    : Math.ceil(all.length / chunk);
  const dup = result.final.length + result.aip.length - all.length;
  const tile = (k, v, hl) => `<div class="stat${hl ? ' hl' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  $('#resultBox').innerHTML = `
    <div class="stats">
      ${tile('Final', fmt(result.final.length))}
      ${tile('Article in Press', fmt(result.aip.length))}
      ${tile('합계' + (dup ? ` (중복 ${dup} 제외)` : ''), fmt(all.length), true)}
      ${tile(`저장될 파일 (${chunk}개씩)`, fmt(files) + '개', true)}
    </div>
    <div class="inline" style="margin-top:12px"><button type="button" id="btnCopyEids">EID 전체 복사</button></div>`;
  $('#btnCopyEids').onclick = () => navigator.clipboard.writeText(all.map((x) => x.eid).join('\n')).then(() => log(`EID ${fmt(all.length)}개를 클립보드에 복사했습니다.`));
  $('#previewWrap').hidden = false;
  renderPreview();
}

function renderPreview() {
  const lists = { all: combined(), final: result.final, aip: result.aip };
  const names = { all: '전체', final: 'Final', aip: 'Article in Press' };
  $('#previewTabs').innerHTML = Object.keys(lists).map((k) =>
    `<button type="button" data-tab="${k}" class="${k === previewTab ? 'active' : ''}">${names[k]}<span class="cnt">${fmt(lists[k].length)}</span></button>`).join('');
  const rows = lists[previewTab];
  if (!rows.length) { $('#previewTable').innerHTML = '<div class="empty">결과가 없습니다.</div>'; return; }
  $('#previewTable').innerHTML = `<table><thead><tr><th>#</th><th>EID</th><th>단계</th><th>제목</th><th>학술지</th><th>발행일</th><th>유형</th></tr></thead><tbody>
    ${rows.slice(0, PREVIEW_ROWS).map((x, i) => `<tr><td class="num">${i + 1}</td><td class="eid">${esc(x.eid)}</td>
      <td><span class="stage ${x.stage}">${x.stage === 'final' ? 'Final' : 'aip'}</span></td>
      <td title="${esc(x.title)}">${esc(x.title)}</td><td title="${esc(x.source)}">${esc(x.source)}</td><td>${esc(x.date)}</td><td>${esc(x.type)}</td></tr>`).join('')}
    </tbody></table>${rows.length > PREVIEW_ROWS ? `<div class="more">… 외 ${fmt(rows.length - PREVIEW_ROWS)}건</div>` : ''}`;
}

// ───────── 저장 ─────────

async function runSave() {
  if (!result) return;
  const folder = $('#folder').value.trim();
  if (!folder) { alert('저장 폴더를 지정해 주세요.'); return; }
  const chunkSize = Math.floor(Number($('#chunk').value));
  if (!(chunkSize >= 1)) { alert('파일당 EID 개수는 1 이상이어야 합니다.'); return; }
  const groups = $('#splitByStage').checked
    ? [{ label: 'Final', eids: result.final.map((x) => x.eid) }, { label: 'aip', eids: result.aip.map((x) => x.eid) }]
    : [{ label: '', eids: combined().map((x) => x.eid) }];
  $('#btnSaveFiles').disabled = true;
  try {
    const res = await api('save', { folder, chunkSize, format: $('#format').value, baseName: $('#baseName').value.trim(), groups });
    if (!res.ok) throw new Error(res.error);
    settings.folder = res.folder;
    saveSettings({ splitByStage: $('#splitByStage').checked });
    const total = res.files.reduce((a, f) => a + f.count, 0);
    log(`저장 완료: ${res.folder} 에 파일 ${res.files.length}개 (EID ${fmt(total)}개)`);
    $('#saveResult').innerHTML = `<div class="notice" style="background:var(--ok-soft);color:var(--ok)"><b>저장 완료</b> — ${esc(res.folder)} 에 ${res.files.length}개 파일</div>
      <ul class="files">${res.files.map((f) => `<li><span>${esc(f.file)}</span><span>${f.count}개</span></li>`).join('')}</ul>`;
  } catch (err) {
    log(`[오류] ${err.message}`, 'e');
    $('#saveResult').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
  } finally {
    $('#btnSaveFiles').disabled = false;
  }
}

// ───────── 초기화 / 이벤트 ─────────

async function init() {
  settings = await api('settings');
  const b = $('#keyBadge');
  if (settings.hasKey) { b.className = 'badge'; b.textContent = 'API 키 로드됨 · ' + settings.keyPreview; }
  else { b.className = 'badge err'; b.textContent = '.env 에 SCOPUS_API_KEY 없음 — 임시 키 입력 가능'; }

  $('#template').value = settings.template || DEFAULT_TEMPLATE;
  $('#count').value = settings.count || 25;
  const [s, e] = quickRange('half');
  $('#startDate').value = settings.startDate || ymd(s);
  $('#endDate').value = settings.endDate || ymd(e);
  $('#folder').value = settings.folder || '';
  $('#chunk').value = settings.chunkSize || 40;
  // 기본은 CSV (Scopus 내보내기와 같은 형식). 엑셀로 바꿔 저장한 적이 있을 때만 xlsx
  $('#format').value = settings.format === 'xlsx' ? 'xlsx' : 'csv';
  $('#splitByStage').checked = !!settings.splitByStage;
  if (settings.folder && !settings.folderExists) log(`[주의] 저장해 둔 폴더가 없습니다: ${settings.folder} (저장할 때 새로 만듭니다)`, 'w');
  refreshQueryPreview();
  log('준비 완료. 기간을 확인하고 "EID 불러오기"를 누르세요.');
}

['#startDate', '#endDate', '#template'].forEach((s) => $(s).addEventListener('input', refreshQueryPreview));
$('#quick').onclick = (e) => {
  const btn = e.target.closest('button[data-q]'); if (!btn) return;
  const [s, t] = quickRange(btn.dataset.q);
  $('#startDate').value = ymd(s); $('#endDate').value = ymd(t);
  refreshQueryPreview();
};
$('#btnResetTpl').onclick = () => { $('#template').value = DEFAULT_TEMPLATE; refreshQueryPreview(); log('쿼리 템플릿을 기본값으로 되돌렸습니다.'); };
document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', () => {
  const text = $(btn.dataset.copy === 'final' ? '#qFinal' : '#qAip').textContent;
  navigator.clipboard.writeText(text).then(() => { btn.textContent = '복사됨'; setTimeout(() => { btn.textContent = '복사'; }, 1200); });
}));
$('#baseName').addEventListener('input', () => { baseNameTouched = $('#baseName').value.trim() !== ''; });
$('#btnFetch').onclick = runFetch;
$('#btnStop').onclick = () => { stopRequested = true; log('중지 요청…', 'w'); };
$('#btnSaveFiles').onclick = runSave;
$('#previewTabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) { previewTab = b.dataset.tab; renderPreview(); } };
['#chunk', '#splitByStage'].forEach((s) => $(s).addEventListener('change', () => {
  if (result) renderResult();
  saveSettings({ chunkSize: Math.floor(Number($('#chunk').value)) || 40, splitByStage: $('#splitByStage').checked });
}));
$('#format').addEventListener('change', () => saveSettings({ format: $('#format').value }));
$('#folder').addEventListener('change', () => saveSettings({ folder: $('#folder').value.trim() }).then(() => log('저장 폴더를 기억했습니다.')));
$('#btnPick').onclick = async () => {
  $('#btnPick').disabled = true;
  log('폴더 선택 창을 열었습니다. (창이 안 보이면 작업 표시줄을 확인하세요)');
  try {
    const r = await api('pick-folder', { initial: $('#folder').value.trim() });
    if (r.ok) { $('#folder').value = r.folder; settings.folder = r.folder; log(`저장 폴더 지정: ${r.folder}`); }
    else if (!r.cancelled) { log(`[오류] ${r.error}`, 'e'); alert(r.error); }
  } finally { $('#btnPick').disabled = false; }
};
$('#btnOpen').onclick = async () => {
  const r = await api('open-folder', { folder: $('#folder').value.trim() });
  if (!r.ok) alert(r.error);
};

init();
})();
