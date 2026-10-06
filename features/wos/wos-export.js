/**
 * Web of Science 고급 검색 → Excel(Full Record) 반출 자동화 (Selenium)
 *
 * 화면 흐름 (2026-09 실제 사이트에서 확인한 요소):
 *   고급 검색  textarea#advancedSearchInputArea 에 쿼리
 *            [data-ta=add-timespan-row] → 날짜 종류 드롭다운(aria-label "Publication Date")
 *            → "Index Date" 그룹 아래의 "Custom" → [data-ta=search-timespan-start-input] / -end-input (YYYY-MM-DD)
 *            → [data-ta=run-search]
 *   결과      주소 /wos/woscc/summary/... , 문서 제목 "쿼리 – 130 – Web of Science Core Collection" 에서 건수
 *   내보내기  #export-trigger-btn → #exportToExcelButton → 창: 범위 radio(name=outputMethodType, fromRange)
 *            + input[name=markFrom] / [name=markTo] (한 번에 최대 1000건)
 *            + Record Content 드롭다운 → #option-fullRecord → #exportButton
 *   ※ 창 안쪽 폭이 좁으면 Export 버튼이 숨겨진다 (실측: 700px 숨김, 767px 이상 보임).
 *     그래서 창 크기는 모니터에 맞추되 안쪽 폭 1024px 아래로는 줄이지 않는다 (fitWindow).
 *
 * 크롬 버전: 설치된 크롬의 주 버전을 매번 읽어서 (주 버전 - 1) 의 Chrome for Testing 과 같은 버전
 * chromedriver 를 Selenium Manager 가 자동으로 받아 쓴다. (드라이버는 브라우저와 주 버전이 같아야 하므로
 * 설치된 크롬에 N-1 드라이버를 붙이는 방식은 동작하지 않는다.) 받은 파일은 %USERPROFILE%\.cache\selenium 에 캐시됨.
 *
 * 사람처럼: 창이 보이는 일반 브라우저, 고정 프로필(쿠키·세션 유지), 클릭 전 마우스 이동, 동작 사이 무작위 쉼,
 *          끊어서 입력. 자동화 표시(navigator.webdriver 등)를 숨기는 위장은 하지 않는다 (이용 약관 문제).
 * 느린 사이트: 모든 대기 시간에 slowFactor(1~3배)를 곱하고, 로딩 표시가 사라질 때까지 기다리며,
 *          검색 단계는 처음부터, 내보내기는 범위별로 최대 RETRIES 번 다시 시도한다.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const XLSX = require('xlsx');

const ADVANCED_URL = 'https://www.webofscience.com/wos/woscc/advanced-search';
const MAX_PER_EXPORT = 1000;
const RETRIES = 3;

// ───────── 크롬 버전 ─────────

const CHROME_PATHS = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

/**
 * 설치된 크롬 버전 (예: "154.0.8037.58"). 실행 파일 버전 → 레지스트리 순으로 찾는다.
 * PowerShell 실행에 1~2초 걸리므로 서버가 멈추지 않게 비동기로.
 */
async function detectChromeVersion() {
  for (const p of CHROME_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:WA_CHROME).VersionInfo.ProductVersion'],
        { env: { ...process.env, WA_CHROME: p }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const v = stdout.trim();
      if (/^\d+\./.test(v)) return { version: v, source: p };
    } catch { /* 다음 방법 */ }
  }
  for (const key of ['HKCU\\Software\\Google\\Chrome\\BLBeacon', 'HKLM\\Software\\Google\\Chrome\\BLBeacon']) {
    try {
      const { stdout: out } = await execFileP('reg', ['query', key, '/v', 'version'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/version\s+REG_SZ\s+([\d.]+)/i);
      if (m) return { version: m[1], source: key };
    } catch { /* 없음 */ }
  }
  return null;
}

async function targetBrowserVersion() {
  const found = await detectChromeVersion();
  if (!found) throw new Error('설치된 크롬을 찾지 못했습니다. 크롬이 설치되어 있는지 확인하세요.');
  const major = parseInt(found.version, 10);
  return { installed: found.version, installedMajor: major, target: String(major - 1) };
}

// ───────── 날짜 ─────────

/** YYYYMMDD → YYYY-MM-DD (없는 날짜면 오류) */
function toDashed(s) {
  if (!/^\d{8}$/.test(s || '')) throw new Error(`날짜 형식은 YYYYMMDD 로 입력해 주세요: ${s || '(빈 값)'}`);
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw new Error(`없는 날짜입니다: ${s}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// ───────── 작업 컨텍스트 (대기 배율·사람 같은 동작) ─────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

class Cancelled extends Error { constructor() { super('사용자가 중지했습니다.'); this.name = 'Cancelled'; } }

function makeCtx(driver, { slowFactor = 1, log, isCancelled }) {
  const f = Math.max(1, Math.min(3, Number(slowFactor) || 1));
  const ctx = {
    driver, log,
    T: (ms) => Math.round(ms * f), // 대기 시간 × 배율
    check() { if (isCancelled()) throw new Cancelled(); },

    /** 사람처럼 잠깐 쉼 (배율과 무관 — 사이트가 느려도 사람 손 속도는 같음) */
    async pause(a = 400, b = 1100) { ctx.check(); await sleep(rand(a, b)); },

    /** 페이지 로딩 표시(스피너·진행바)가 사라질 때까지 */
    async settle(timeout = 30000) {
      const deadline = Date.now() + ctx.T(timeout);
      while (Date.now() < deadline) {
        ctx.check();
        const busy = await driver.executeScript(`
          if (document.readyState !== 'complete') return true;
          const sel = 'mat-spinner, mat-progress-spinner, mat-progress-bar, .loading-spinner, .spinner, [class*="loading-overlay"], [aria-busy="true"]';
          return [...document.querySelectorAll(sel)].some((e) => e.offsetParent !== null);`).catch(() => true);
        if (!busy) return;
        await sleep(400);
      }
      // 끝까지 로딩 표시가 남아 있어도 다음 단계에서 요소를 기다리므로 여기서는 실패로 보지 않는다
    },

    async waitFor(locator, timeout = 30000, what = '') {
      ctx.check();
      try {
        const el = await driver.wait(until.elementLocated(locator), ctx.T(timeout));
        await driver.wait(until.elementIsVisible(el), ctx.T(timeout));
        return el;
      } catch (err) {
        if (isCancelled()) throw new Cancelled();
        throw new Error(`화면에서 ${what || locator} 을(를) 찾지 못했습니다 (${Math.round(ctx.T(timeout) / 1000)}초 기다림). 사이트가 느리면 "대기 시간"을 늘려 보세요.`);
      }
    },

    /** 마우스를 요소로 옮긴 뒤 클릭. 가려져서 실패하면 JS 클릭으로 한 번 더. */
    async click(el) {
      ctx.check();
      await driver.executeScript('arguments[0].scrollIntoView({block:"center", behavior:"smooth"})', el);
      await sleep(rand(250, 550));
      try {
        await driver.actions({ async: true }).move({ origin: el, duration: Math.round(rand(150, 400)) }).perform();
        await sleep(rand(80, 220));
        await el.click();
      } catch {
        await driver.executeScript('arguments[0].click()', el);
      }
      await ctx.pause(300, 800);
    },

    /** 끊어서 입력 (한 번에 붙여넣지 않음). 기존 내용은 Ctrl+A → Delete. Angular 화면이라 실제 키 입력이 필요함. */
    async type(el, text) {
      await ctx.click(el);
      await el.sendKeys(Key.CONTROL, 'a');
      await el.sendKeys(Key.DELETE);
      await sleep(rand(150, 350));
      const chunks = String(text).match(/.{1,12}/gs) || [];
      for (const c of chunks) {
        ctx.check();
        await el.sendKeys(c);
        await sleep(rand(40, 140));
      }
      await ctx.pause(250, 600);
    },

    /** 쿠키 안내·사이트 투어 팝업 닫기 (없으면 넘어감). 쿠키는 '닫기'(필수 쿠키만). */
    async dismissPopups() {
      await driver.executeScript(`
        const close = (sel) => document.querySelectorAll(sel).forEach((b) => { if (b.offsetParent !== null) try { b.click(); } catch (e) {} });
        close('#onetrust-close-btn-handler');
        close('#onetrust-banner-sdk button[aria-label="닫기"], #onetrust-banner-sdk button[aria-label="Close"]');
        close('._pendo-close-guide');`).catch(() => {});
    },

    /** 실패하면 다시 시도 (중지는 바로 끝냄) */
    async retry(what, fn) {
      let lastErr;
      for (let i = 1; i <= RETRIES; i++) {
        ctx.check();
        try { return await fn(i); } catch (err) {
          if (err instanceof Cancelled || isCancelled()) throw new Cancelled();
          lastErr = err;
          if (i < RETRIES) {
            log(`${what} 실패 (${i}/${RETRIES}): ${err.message} → 잠시 후 다시 시도합니다.`, 'w');
            await sleep(ctx.T(3000 * i));
          }
        }
      }
      throw new Error(`${what}을(를) ${RETRIES}번 시도했지만 실패했습니다: ${lastErr.message}`);
    },
  };
  return ctx;
}

// ───────── 본 작업 ─────────

/**
 * @param {object} opt
 *   query, startDate, endDate (YYYYMMDD), downloadDir, headless, slowFactor(1~3),
 *   profileDir  자동화 크롬 프로필 폴더 (쿠키·로그인 유지)
 *   log(msg, level), progress(pct, text), isCancelled(), onDriver(driver)
 * @returns {{ total, files: string[] }}  받은 원본 엑셀 파일 경로들 (순서대로)
 */
async function runExport(opt) {
  const { query, startDate, endDate, downloadDir, headless, profileDir, log, progress, isCancelled } = opt;
  const from = toDashed(startDate), to = toDashed(endDate);
  if (to < from) throw new Error('마지막일이 시작일보다 빠릅니다.');
  if (!query || !query.trim()) throw new Error('쿼리가 비어 있습니다.');

  const ver = await targetBrowserVersion();
  log(`설치된 크롬 ${ver.installed} → 자동화용 크롬 ${ver.target} 버전 사용 (처음 한 번은 내려받느라 1~3분 걸릴 수 있음)`);
  progress(3, `크롬 ${ver.target} 준비 중…`);

  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  await closeLeftoverChrome(profileDir, log);
  const options = new chrome.Options()
    .setBrowserVersion(ver.target)
    .addArguments(`--user-data-dir=${profileDir}`, headless ? '--window-size=1366,900' : '--window-size=1100,800',
      '--lang=ko-KR', '--no-first-run', '--no-default-browser-check')
    .setUserPreferences({
      'download.default_directory': downloadDir,
      'download.prompt_for_download': false,
      'download.directory_upgrade': true,
      // 같은 사이트에서 여러 번 받을 때 "여러 파일 다운로드 허용?" 확인이 뜨지 않게
      'profile.default_content_setting_values.automatic_downloads': 1,
      'intl.accept_languages': 'ko-KR,ko,en-US,en',
    });
  if (headless) options.addArguments('--headless=new');

  let driver;
  try {
    driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  } catch (err) {
    throw new Error(`자동화용 크롬을 실행하지 못했습니다: ${String(err.message).split('\n')[0]} (인터넷 연결, 백신/방화벽 차단, 다른 반출 창이 열려 있는지 확인하세요)`);
  }
  opt.onDriver && opt.onDriver(driver);
  const ctx = makeCtx(driver, opt);

  try {
    const caps = await driver.getCapabilities();
    log(`자동화 크롬 실행됨: ${caps.get('browserVersion')}`);
    await driver.manage().setTimeouts({ pageLoad: ctx.T(120000), script: ctx.T(60000) });
    if (!headless) await fitWindow(driver, log);
    try { await driver.sendDevToolsCommand('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }); } catch { /* 무시 */ }

    // 1~4) 검색까지: 실패하면 고급 검색 화면부터 다시
    const total = await ctx.retry('검색', async (attempt) => {
      progress(10, attempt > 1 ? `검색 다시 시도 중 (${attempt}/${RETRIES})…` : '고급 검색 화면 여는 중…');
      await driver.get(ADVANCED_URL);
      await waitForSearchPageOrLogin(ctx, { headless });
      await ctx.settle();
      await ctx.pause(1200, 2200); // 화면을 훑어보는 시간
      await ctx.dismissPopups();

      progress(20, '쿼리 입력 중…');
      await ctx.type(await ctx.waitFor(By.css('#advancedSearchInputArea'), 30000, '쿼리 입력칸'), query.trim());

      progress(30, 'Index Date 기간 설정 중…');
      await ctx.dismissPopups();
      await setIndexDateRange(ctx, from, to);
      log(`검색 조건: Index Date ${from} ~ ${to}`);

      progress(40, '검색 중…');
      await ctx.click(await ctx.waitFor(By.css('[data-ta="run-search"]'), 10000, 'Search 버튼'));
      return waitForResults(ctx);
    });
    log(`검색 결과 ${total.toLocaleString('ko-KR')}건`);
    if (!total) return { total: 0, files: [] };
    await ctx.settle();
    await ctx.pause(1500, 3000); // 결과 목록을 보는 시간

    // 5) 1000건씩 Excel(Full Record) 내보내기 — 범위별로 다시 시도
    const files = [];
    const parts = Math.ceil(total / MAX_PER_EXPORT);
    for (let i = 0; i < parts; i++) {
      const a = i * MAX_PER_EXPORT + 1, b = Math.min(total, (i + 1) * MAX_PER_EXPORT);
      const file = await ctx.retry(`${a}~${b}건 내보내기`, async (attempt) => {
        progress(45 + Math.round((i / parts) * 45), `Excel 내보내기 ${i + 1}/${parts} (${a}~${b}건)…`);
        await closeExportDialog(ctx);
        // 매 범위·시도마다 빈 폴더로 받는다: WoS 는 항상 같은 이름(savedrecs.xls)으로 주고,
        // 이 자동화 크롬은 같은 이름이면 "(1)"을 붙이지 않고 덮어쓰기 때문 (실측: 두 번째 범위가 첫 파일을 덮어씀)
        const partDir = path.join(downloadDir, `part_${String(i + 1).padStart(2, '0')}_try${attempt}`);
        const got = await exportRange(ctx, { from: a, to: b, partDir });
        // 받은 행 수가 요청한 범위와 같은지 확인 (다르면 이 범위를 다시 받음)
        const rows = countDataRows(got);
        if (rows !== b - a + 1) throw new Error(`받은 파일이 ${rows}행입니다 (기대 ${b - a + 1}행: ${a}~${b}건).`);
        const dest = path.join(downloadDir, `part_${String(i + 1).padStart(2, '0')}${path.extname(got) || '.xls'}`);
        fs.renameSync(got, dest);
        return dest;
      });
      files.push(file);
      log(`받음 ${i + 1}/${parts}: ${a}~${b}건 → ${path.basename(file)}`);
      if (i < parts - 1) await ctx.pause(3000, 6000); // 연속 내보내기 사이 쉬는 시간
    }
    return { total, files };
  } finally {
    try { await driver.quit(); } catch { /* 이미 닫힘 */ }
  }
}

/**
 * 지난 반출이 중간에 끊겨(서버 창을 닫음, PC 강제 종료 등) 남아 있는 자동화 크롬을 정리한다.
 * 정상 종료·오류·중지 때는 runExport 의 finally 에서 driver.quit() 으로 닫히지만, 서버가 갑자기 꺼지면 그럴 기회가 없다.
 * 남은 크롬이 전용 프로필을 잡고 있으면 새 크롬이 "프로필 사용 중"으로 실패하므로 시작 전에 끈다.
 * 명령줄에 이 전용 프로필 폴더가 들어 있는 chrome.exe 만 대상 → 평소 쓰는 크롬은 건드리지 않는다.
 */
async function closeLeftoverChrome(profileDir, log) {
  if (process.platform !== 'win32') return;
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command',
      '$p = $env:WA_PROFILE; $n = 0; ' +
      'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n'],
    { env: { ...process.env, WA_PROFILE: profileDir }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const n = parseInt(stdout.trim(), 10) || 0;
    if (n) {
      log(`지난번에 끝나지 않고 남아 있던 자동화 크롬 ${n}개 프로세스를 정리했습니다.`, 'w');
      await sleep(1500);
    }
  } catch { /* 정리 실패해도 계속 진행 (크롬 실행 단계에서 오류로 알려짐) */ }
}

const MIN_VIEWPORT_WIDTH = 1024; // 이보다 좁으면 WoS 가 Export 버튼을 숨길 수 있음 (실측 경계 700~767px, 여유 둠)

/**
 * 창 크기를 모니터에 맞춘다: 사용 가능 영역(작업 표시줄 제외, 배율 반영된 CSS px)의 폭 80%·높이 85%,
 * 최대 1280×900, 화면 가운데. 단 안쪽 폭은 MIN_VIEWPORT_WIDTH 아래로 줄이지 않는다.
 */
async function fitWindow(driver, log) {
  try {
    const s = await driver.executeScript(
      'return { w: screen.availWidth, h: screen.availHeight, x: screen.availLeft || 0, y: screen.availTop || 0, chromeW: window.outerWidth - window.innerWidth }');
    const frame = Math.max(0, s.chromeW || 16); // 창 테두리 두께 (바깥 폭 - 안쪽 폭)
    let width = Math.min(1280, Math.round(s.w * 0.8));
    width = Math.max(width, MIN_VIEWPORT_WIDTH + frame);
    const height = Math.min(900, Math.round(s.h * 0.85));
    const x = s.x + Math.max(0, Math.round((s.w - width) / 2));
    const y = s.y + Math.max(0, Math.round((s.h - height) / 2));
    await driver.manage().window().setRect({ width, height, x, y });
    const inner = await driver.executeScript('return window.innerWidth');
    log(`브라우저 창 크기 ${width}×${height} (모니터 ${s.w}×${s.h} 기준)`);
    if (width > s.w) log(`[주의] 모니터가 좁아 창이 화면보다 조금 큽니다. WoS 는 창 폭이 좁으면 Export 버튼을 숨겨서 최소 폭(${MIN_VIEWPORT_WIDTH}px)을 유지했습니다.`, 'w');
    if (inner < MIN_VIEWPORT_WIDTH) log(`[주의] 창 안쪽 폭이 ${inner}px 입니다. 화면 배율을 낮추면 더 안정적입니다.`, 'w');
  } catch (err) {
    log(`창 크기 조정 실패 (기본 크기로 진행): ${err.message}`, 'w');
  }
}

/** 고급 검색 화면이 뜰 때까지. 기관 인증이 안 돼 로그인 화면으로 가면 사용자가 직접 로그인하길 기다린다. */
async function waitForSearchPageOrLogin(ctx, { headless }) {
  const deadline = Date.now() + Math.max(5 * 60 * 1000, ctx.T(60000));
  let warned = false;
  while (Date.now() < deadline) {
    ctx.check();
    const [url, ready] = await ctx.driver.executeScript('return [location.href, !!document.querySelector("#advancedSearchInputArea")]').catch(() => ['', false]);
    if (ready) return;
    if (/access\.clarivate\.com|login|signin/i.test(url) && !warned) {
      warned = true;
      if (headless) throw new Error('Web of Science 로그인이 필요합니다. "브라우저 창 숨기기"를 끄고 다시 실행한 뒤 열린 창에서 직접 로그인하세요 (교내망이면 보통 로그인 없이 됩니다).');
      ctx.log('로그인 화면이 열렸습니다. 자동화 크롬 창에서 직접 로그인해 주세요 (최대 5분 기다립니다).', 'w');
    }
    await sleep(1000);
  }
  throw new Error('고급 검색 화면이 열리지 않았습니다 (로그인 대기 시간 초과 또는 네트워크 문제).');
}

async function setIndexDateRange(ctx, from, to) {
  const { driver } = ctx;
  // 이전 시도에서 남은 날짜 줄이 있으면 그대로 쓰고, 없으면 추가
  const hasRow = await driver.executeScript('return !!document.querySelector(\'button[aria-label="Publication Date"], button[aria-label="Index Date"]\')');
  if (!hasRow) {
    await ctx.click(await ctx.waitFor(By.css('[data-ta="add-timespan-row"]'), 15000, '"Add date range" 버튼'));
    await ctx.settle(5000);
  }
  const typeBtn = await ctx.waitFor(By.css('button[aria-label="Publication Date"], button[aria-label="Index Date"]'), 15000, '날짜 종류 드롭다운');
  const current = await typeBtn.getAttribute('aria-label');
  const startVisible = await driver.executeScript('const e = document.querySelector(\'[data-ta="search-timespan-end-input"]\'); return !!(e && e.offsetParent)');
  if (current !== 'Index Date' || !startVisible) {
    await ctx.click(typeBtn);
    await sleep(ctx.T(600));
    // 목록: [Publication Date] All years / Last 5 years / Custom  [Index Date] Current week / … / Custom
    const picked = await driver.executeScript(`
      const nodes = [...document.querySelectorAll('[role="option"], [role="group"], [class*="group-header"], [class*="group-label"], .wrap-mode')]
        .filter((n) => n.offsetParent !== null);
      let inIndex = false, target = null;
      for (const n of nodes) {
        const t = (n.innerText || '').trim();
        if (t === 'Index Date') inIndex = true;
        else if (t === 'Publication Date') inIndex = false;
        else if (inIndex && t === 'Custom') { target = n; break; }
      }
      if (!target) { const customs = nodes.filter((n) => (n.innerText || '').trim() === 'Custom'); target = customs[customs.length - 1] || null; }
      if (!target) return false;
      target.scrollIntoView({ block: 'center' }); target.click(); return true;`);
    if (!picked) throw new Error('날짜 드롭다운에서 "Index Date > Custom" 을 찾지 못했습니다.');
    await ctx.pause(500, 900);
  }
  const label = await driver.executeScript(`
    const b = document.querySelector('button[aria-label="Index Date"], button[aria-label="Publication Date"]');
    return b ? b.getAttribute('aria-label') : '';`);
  if (label !== 'Index Date') throw new Error(`날짜 종류가 Index Date 로 바뀌지 않았습니다 (현재: ${label || '알 수 없음'}).`);
  const s = await ctx.waitFor(By.css('[data-ta="search-timespan-start-input"]'), 10000, '시작일 입력칸');
  await ctx.type(s, from);
  const e = await ctx.waitFor(By.css('[data-ta="search-timespan-end-input"]'), 10000, '종료일 입력칸');
  await ctx.type(e, to);
  const [sv, ev] = await driver.executeScript(`return [document.querySelector('[data-ta="search-timespan-start-input"]').value, document.querySelector('[data-ta="search-timespan-end-input"]').value]`);
  if (sv !== from || ev !== to) throw new Error(`날짜가 제대로 들어가지 않았습니다 (시작 ${sv || '빈칸'}, 끝 ${ev || '빈칸'}).`);
}

/** 검색 결과 페이지가 뜨면 건수를 돌려준다. 결과 0건이면 0. */
async function waitForResults(ctx) {
  const deadline = Date.now() + ctx.T(120 * 1000);
  while (Date.now() < deadline) {
    ctx.check();
    const r = await ctx.driver.executeScript(`
      const onSummary = /\\/summary\\//.test(location.pathname);
      const m = document.title.match(/[–-]\\s*([\\d,]+)\\s*[–-]\\s*Web of Science/);
      const text = document.body ? document.body.innerText : '';
      const noResult = /your search found no results|검색 결과가 없습니다|no records found/i.test(text);
      const error = document.querySelector('.search-error, [data-ta="search-error"], mat-error');
      return { onSummary, count: m ? Number(m[1].replace(/,/g, '')) : null, noResult, error: error && error.offsetParent ? error.innerText.trim() : '' };`).catch(() => ({}));
    if (r.onSummary && r.count !== null && r.count !== undefined) return r.count;
    if (r.noResult) return 0;
    if (r.error) throw new Error(`검색 오류: ${r.error.slice(0, 200)}`);
    await sleep(800);
  }
  throw new Error(`검색 결과 페이지가 열리지 않았습니다 (${Math.round(ctx.T(120))}초 초과). 쿼리 문법을 확인하세요.`);
}

/** 받은 엑셀의 데이터 행 수 (머리행 제외, 빈 행 제외) */
function countDataRows(file) {
  const wb = XLSX.readFile(file, { dense: true });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, blankrows: false });
  return Math.max(0, aoa.length - 1);
}

/** 다운로드 받을 폴더를 바꾼다 (크롬 DevTools 명령) */
async function setDownloadDir(driver, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await driver.sendDevToolsCommand('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
}

async function closeExportDialog(ctx) {
  await ctx.driver.executeScript(`
    const c = [...document.querySelectorAll('.cdk-overlay-pane button')].find((b) => b.innerText.trim() === 'Cancel' && b.offsetParent);
    if (c) c.click();`).catch(() => {});
  await sleep(ctx.T(500));
}

/** 한 범위를 내보내서 partDir(빈 폴더)에 받은 파일 경로를 돌려준다. Export 메뉴를 매번 새로 연다. */
async function exportRange(ctx, { from, to, partDir }) {
  const { driver } = ctx;
  await setDownloadDir(driver, partDir);
  await ctx.dismissPopups();
  await ctx.click(await ctx.waitFor(By.css('#export-trigger-btn'), 30000, 'Export 버튼'));
  await ctx.click(await ctx.waitFor(By.css('#exportToExcelButton'), 15000, 'Export 메뉴의 Excel'));
  await ctx.waitFor(By.css('#exportButton'), 30000, '내보내기 창');
  await ctx.settle(10000);
  await ctx.pause(500, 1000);

  // 범위 지정 (Records from … to …)
  await driver.executeScript(`
    const r = document.querySelector('input[name="outputMethodType"][value="fromRange"]')
      || [...document.querySelectorAll('input[name="outputMethodType"]')].find((x) => /range/i.test(x.value));
    if (r) { (r.closest('mat-radio-button, label') || r).click(); if (!r.checked) r.click(); }`);
  await ctx.pause(300, 600);
  await ctx.type(await ctx.waitFor(By.css('input[name="markFrom"]'), 10000, '시작 레코드 입력칸'), String(from));
  await ctx.type(await ctx.waitFor(By.css('input[name="markTo"]'), 10000, '끝 레코드 입력칸'), String(to));

  // Record Content = Full Record
  const contentLabel = () => driver.executeScript(`
    const pane = document.querySelector('#exportButton').closest('.cdk-overlay-pane, mat-dialog-container') || document;
    const b = pane.querySelector('button[role="combobox"]');
    return b ? b.innerText.trim() : '';`);
  if (!/full record/i.test(await contentLabel())) {
    const combo = await driver.executeScript(`
      const pane = document.querySelector('#exportButton').closest('.cdk-overlay-pane, mat-dialog-container') || document;
      return pane.querySelector('button[role="combobox"]');`);
    await ctx.click(combo);
    await ctx.click(await ctx.waitFor(By.css('#option-fullRecord'), 10000, 'Record Content 의 Full Record'));
  }
  const label = await contentLabel();
  if (!/full record/i.test(label)) throw new Error(`Record Content 를 Full Record 로 바꾸지 못했습니다 (현재: ${label || '알 수 없음'}).`);
  const [vf, vt] = await driver.executeScript(`return [document.querySelector('input[name="markFrom"]').value, document.querySelector('input[name="markTo"]').value]`);
  if (String(vf) !== String(from) || String(vt) !== String(to)) throw new Error(`내보내기 범위가 제대로 들어가지 않았습니다 (${vf}~${vt}).`);

  await ctx.click(await driver.findElement(By.css('#exportButton')));

  // 파일이 다 받아질 때까지 (Full Record 1000건은 서버에서 만드는 데 시간이 걸릴 수 있음)
  // partDir 는 이번 범위 전용 빈 폴더라 여기 생긴 파일이 곧 이번 파일이다.
  const deadline = Date.now() + ctx.T(5 * 60 * 1000);
  let lastSize = -1;
  while (Date.now() < deadline) {
    ctx.check();
    const names = fs.readdirSync(partDir);
    const pending = names.some((f) => /\.(crdownload|tmp)$/i.test(f));
    const done = names.filter((f) => !/\.(crdownload|tmp)$/i.test(f));
    if (done.length && !pending) {
      const file = path.join(partDir, done[0]);
      const size = fs.statSync(file).size;
      // 크기가 두 번 연속 같으면 쓰기가 끝난 것으로 본다
      if (size > 0 && size === lastSize) {
        await closeExportDialog(ctx);
        return file;
      }
      lastSize = size;
    }
    await sleep(800);
  }
  throw new Error(`파일이 ${Math.round(ctx.T(300))}초 안에 받아지지 않았습니다.`);
}

module.exports = { runExport, detectChromeVersion, targetBrowserVersion, toDashed, Cancelled, MAX_PER_EXPORT };
