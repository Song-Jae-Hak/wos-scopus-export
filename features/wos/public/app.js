/*
 * Web of Science 논문 반출 — 화면 쪽
 * 실제 브라우저 조작은 서버(router.js → wos-export.js)가 하고, 여기서는 설정 입력·진행 상황 표시만 한다.
 * 작업은 서버에서 돌기 때문에 페이지를 새로고침해도 진행 상황을 다시 이어서 보여준다.
 */
(() => {
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (n) => Number(n).toLocaleString('ko-KR');
const ymd = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

// 진행률(서버 progress 값) 기준 단계
const STEPS = [
  { at: 3, label: '자동화 크롬 준비 (설치된 크롬 버전 - 1)' },
  { at: 10, label: '고급 검색 화면 열기' },
  { at: 20, label: '쿼리 입력' },
  { at: 30, label: 'Index Date > Custom 기간 입력' },
  { at: 40, label: '검색' },
  { at: 45, label: 'Excel(Full Record) 내보내기 (1000건씩)' },
  { at: 93, label: '받은 파일 합치기 + RG 열 추가' },
  { at: 100, label: '저장 폴더에 저장' },
];

let settings = {};
let pollTimer = null;
let fileNameTouched = false;

async function api(path, body) {
  const r = await fetch('api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
const saveSettings = (patch) => api('settings', patch).catch(() => {});

// ───────── 날짜 ─────────

function dashed(s) {
  if (!/^\d{8}$/.test(s)) throw new Error('날짜 형식은 YYYYMMDD 로 입력해 주세요.');
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw new Error(`없는 날짜입니다: ${s}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function quickRange(kind) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const yest = new Date(t); yest.setDate(t.getDate() - 1);
  if (kind === 'w1' || kind === 'w2') { const s = new Date(t); s.setDate(t.getDate() - (kind === 'w1' ? 7 : 14)); return [s, yest]; }
  if (kind === 'lastMonth') return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)];
  if (kind === 'thisMonth') { const first = new Date(t.getFullYear(), t.getMonth(), 1); return [first, yest < first ? t : yest]; }
  if (t.getDate() > 15) return [new Date(t.getFullYear(), t.getMonth(), 1), new Date(t.getFullYear(), t.getMonth(), 15)];
  return [new Date(t.getFullYear(), t.getMonth() - 1, 16), new Date(t.getFullYear(), t.getMonth(), 0)];
}

function refreshDates() {
  const s = $('#startDate').value.trim(), e = $('#endDate').value.trim();
  try {
    const a = dashed(s), b = dashed(e);
    if (b < a) throw new Error('마지막일이 시작일보다 빠릅니다.');
    $('#conv').innerHTML = `WoS 검색 시: Index Date <b>${a}</b> ~ <b>${b}</b>`;
  } catch (err) {
    $('#conv').innerHTML = `<span style="color:var(--err)">${esc(err.message)}</span>`;
  }
  if (!fileNameTouched) $('#fileName').value = `WoS_${s || 'start'}-${e || 'end'}_${ymd(new Date())}`;
}

function refreshQueryState() {
  const same = $('#query').value.trim() === (settings.defaultQuery || '').trim();
  $('#queryState').textContent = same ? '기본 쿼리' : '수정한 쿼리 (실행하면 저장됨)';
}

// ───────── 진행 표시 ─────────

function renderSteps(job) {
  const p = job ? job.progress : -1;
  const failed = job && (job.state === 'error' || job.state === 'cancelled');
  const done = job && job.state === 'done';
  let nowIdx = -1;
  STEPS.forEach((s, i) => { if (p >= s.at) nowIdx = i; });
  $('#steps').innerHTML = STEPS.map((s, i) => {
    let cls = '';
    if (done) cls = 'done';
    else if (i < nowIdx) cls = 'done';
    else if (i === nowIdx) cls = failed ? 'fail' : 'now';
    const mark = cls === 'done' ? '✓' : cls === 'fail' ? '!' : '';
    return `<li class="${cls}"><span class="dot">${mark}</span>${esc(s.label)}</li>`;
  }).join('');
}

function renderLog(job) {
  const el = $('#log');
  el.innerHTML = (job ? job.log : []).map((l) => `<span class="${l.level || ''}">${esc(l.t)}  ${esc(l.msg)}\n</span>`).join('');
  el.scrollTop = el.scrollHeight;
}

function renderResult(job) {
  const box = $('#resultBox');
  if (!job) return;
  if (job.state === 'running') {
    box.innerHTML = `<div class="empty">진행 중… 자동화 크롬 창은 건드리지 말고 기다려 주세요.</div>`;
    return;
  }
  if (job.state !== 'done') {
    box.innerHTML = `<div class="notice ${job.state === 'cancelled' ? 'warn' : 'err'}">${esc(job.error || '실패')}</div>`;
    return;
  }
  const r = job.result || {};
  if (!r.total) { box.innerHTML = '<div class="notice warn">검색 결과가 0건이라 저장한 파일이 없습니다.</div>'; return; }
  const tile = (k, v, hl) => `<div class="stat${hl ? ' hl' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const mismatch = r.rows !== r.total
    ? `<div class="notice warn"><b>확인 필요</b> — 검색 결과 ${fmt(r.total)}건, 받은 행 ${fmt(r.rows)}건</div>` : '';
  box.innerHTML = `
    <div class="stats">
      ${tile('검색 결과', fmt(r.total))}
      ${tile('받은 파일 (1000건 단위)', fmt(r.parts) + '개')}
      ${tile('저장한 행', fmt(r.rows), true)}
      ${tile('RG (받은 날짜)', esc(r.rg), true)}
    </div>
    ${mismatch}
    <div class="saved">저장 완료: <span class="fn">${esc(r.fullPath)}</span>
      <button type="button" id="btnOpenSaved">폴더 열기</button></div>`;
  $('#btnOpenSaved').onclick = () => api('open-folder', { folder: r.folder }).then((x) => { if (!x.ok) alert(x.error); });
}

function setRunning(running) {
  $('#btnRun').disabled = running;
  $('#btnStop').disabled = !running;
  document.querySelectorAll('#startDate,#endDate,#query,#folder,#fileName,#slowFactor,#headless,#btnPick,#btnResetQuery,#quick button')
    .forEach((el) => { el.disabled = running; });
}

async function poll() {
  let job;
  try { job = await api('job'); } catch { return; }
  if (!job) { renderSteps(null); return; }
  $('#bar').style.width = job.progress + '%';
  $('#statusLine').textContent = job.text || '';
  renderSteps(job); renderLog(job); renderResult(job);
  const running = job.state === 'running';
  setRunning(running);
  clearTimeout(pollTimer);
  if (running) pollTimer = setTimeout(poll, 1000);
}

// ───────── 실행 ─────────

async function run() {
  const body = {
    query: $('#query').value.trim(),
    startDate: $('#startDate').value.trim(),
    endDate: $('#endDate').value.trim(),
    folder: $('#folder').value.trim(),
    fileName: $('#fileName').value.trim(),
    headless: $('#headless').checked,
    slowFactor: Number($('#slowFactor').value),
  };
  try { dashed(body.startDate); dashed(body.endDate); } catch (err) { alert(err.message); return; }
  if (!body.folder) { alert('저장 폴더를 지정해 주세요.'); return; }
  const r = await api('run', body);
  if (!r.ok) { alert(r.error); return; }
  refreshQueryState();
  setRunning(true);
  poll();
}

async function init() {
  settings = await api('settings');
  $('#query').value = settings.query || settings.defaultQuery;
  const [s, e] = quickRange('half');
  $('#startDate').value = settings.startDate || ymd(s);
  $('#endDate').value = settings.endDate || ymd(e);
  $('#folder').value = settings.folder || '';
  $('#headless').checked = !!settings.headless;
  $('#slowFactor').value = String(settings.slowFactor || 1);
  const c = settings.chrome || {};
  const badge = $('#chromeBadge');
  if (c.error) { badge.className = 'badge err'; badge.textContent = c.error; }
  else { badge.className = 'badge'; badge.textContent = `크롬 ${c.installedMajor} 설치됨 → 자동화용 ${c.target} 사용`; }
  $('#envInfo').innerHTML = c.error ? '' :
    `설치된 크롬 <b>${esc(c.installed)}</b> · 자동화용 크롬 <b>${esc(c.target)}</b> (실행할 때마다 버전을 다시 확인합니다).<br>
     처음 실행할 때는 자동화용 크롬(약 150MB)을 내려받느라 1~3분 걸립니다. 실행 중에는 자동화 크롬 창을 건드리지 마세요.`;
  refreshDates();
  refreshQueryState();
  poll();
}

$('#startDate').addEventListener('input', refreshDates);
$('#endDate').addEventListener('input', refreshDates);
$('#query').addEventListener('input', refreshQueryState);
$('#fileName').addEventListener('input', () => { fileNameTouched = $('#fileName').value.trim() !== ''; });
$('#quick').onclick = (e) => {
  const b = e.target.closest('button[data-q]'); if (!b) return;
  const [s, t] = quickRange(b.dataset.q);
  $('#startDate').value = ymd(s); $('#endDate').value = ymd(t);
  refreshDates();
};
$('#btnResetQuery').onclick = () => {
  $('#query').value = settings.defaultQuery;
  saveSettings({ query: settings.defaultQuery });
  refreshQueryState();
};
$('#headless').addEventListener('change', () => saveSettings({ headless: $('#headless').checked }));
$('#slowFactor').addEventListener('change', () => saveSettings({ slowFactor: Number($('#slowFactor').value) }));
$('#folder').addEventListener('change', () => saveSettings({ folder: $('#folder').value.trim() }));
$('#btnPick').onclick = async () => {
  $('#btnPick').disabled = true;
  try {
    const r = await api('pick-folder', { initial: $('#folder').value.trim() });
    if (r.ok) $('#folder').value = r.folder;
    else if (!r.cancelled) alert(r.error);
  } finally { $('#btnPick').disabled = false; }
};
$('#btnOpen').onclick = () => api('open-folder', { folder: $('#folder').value.trim() }).then((x) => { if (!x.ok) alert(x.error); });
$('#btnRun').onclick = run;
$('#btnStop').onclick = () => api('cancel', {}).then(poll);

init();
})();
