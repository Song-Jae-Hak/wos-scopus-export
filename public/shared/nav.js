/*
 * 기능 페이지 공통 메뉴 — <script src="/shared/nav.js" defer></script> 한 줄로 붙인다.
 * "← 홈" 링크 옆에 같은 구역의 다른 기능으로 가는 메뉴를 붙인다 (구역에 기능이 2개 이상일 때).
 * 페이지마다 헤더 색이 달라서(KCI 는 파란 배경) 글자색은 헤더를 따르고, 펼친 목록만 흰/어두운 판으로 그린다.
 */
(() => {
  'use strict';
  const id = decodeURIComponent(location.pathname.split('/')[1] || '');
  if (!id) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // details.wa-nav 로 우선순위를 올린다: 페이지 자체의 details/summary 스타일(예: KCI 의 흰 상자)이 덮어쓰지 않게
  const css = `
    details.wa-nav{position:relative;display:inline-block;vertical-align:middle;margin:0 0 0 6px;padding:0;border:0;background:none;box-shadow:none;
      color:inherit;font:12.5px/1.4 "Pretendard","Malgun Gothic","Apple SD Gothic Neo",sans-serif}
    details.wa-nav>summary{list-style:none;cursor:pointer;padding:4px 10px;border-radius:99px;border:1px solid;border-color:color-mix(in srgb,currentColor 35%,transparent);
      white-space:nowrap;user-select:none;opacity:.9;color:inherit;font-weight:inherit;background:none;margin:0}
    .wa-nav>summary::-webkit-details-marker{display:none}
    .wa-nav>summary:hover,.wa-nav[open]>summary{opacity:1;border-color:currentColor}
    .wa-nav .wa-caret{display:inline-block;margin-left:4px;font-size:10px;transition:transform .15s}
    .wa-nav[open] .wa-caret{transform:rotate(180deg)}
    .wa-nav-menu{position:absolute;left:0;top:calc(100% + 6px);z-index:1000;min-width:240px;padding:6px;border-radius:10px;
      background:var(--panel,#fff);color:var(--ink,#1b2027);border:1px solid var(--line,#e1e5eb);box-shadow:0 8px 24px rgba(16,24,40,.16)}
    .wa-nav-menu .wa-h{font-size:11px;color:var(--dim,#667085);padding:4px 8px 6px;font-weight:600;letter-spacing:.02em}
    .wa-nav-menu a{display:block;padding:7px 8px;border-radius:6px;color:inherit;text-decoration:none;opacity:1}
    .wa-nav-menu a:hover{background:var(--accent-soft,#eaf1fc)}
    .wa-nav-menu a.cur{background:var(--accent-soft,#eaf1fc);color:var(--accent,#1f5fbf);font-weight:650}
    .wa-nav-menu a small{display:block;font-size:11px;color:var(--dim,#667085);font-weight:400;margin-top:1px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
    .wa-nav-menu .wa-home{border-top:1px solid var(--line,#e1e5eb);margin-top:4px;padding-top:9px;font-size:12px;color:var(--dim,#667085)}`;

  fetch('/api/features').then((r) => r.json()).then(({ groups = [], features = [] }) => {
    const me = features.find((f) => f.id === id);
    if (!me) return;
    const siblings = features.filter((f) => f.group === me.group).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    if (siblings.length < 2) return;
    const group = groups.find((g) => g.id === me.group) || { title: me.group };
    const home = document.querySelector('.home-link');
    if (!home) return;

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const nav = document.createElement('details');
    nav.className = 'wa-nav';
    nav.innerHTML = `<summary title="${esc(group.title)}의 다른 기능">${esc(group.title)}<span class="wa-caret">▼</span></summary>
      <div class="wa-nav-menu" role="menu">
        <div class="wa-h">${esc(group.title)}</div>
        ${siblings.map((f) => `<a role="menuitem" href="${esc(f.href)}" class="${f.id === id ? 'cur' : ''}">${esc(f.title)}<small>${esc(f.description)}</small></a>`).join('')}
        <a class="wa-home" href="/">← 홈에서 전체 기능 보기</a>
      </div>`;
    home.insertAdjacentElement('afterend', nav);

    // 바깥을 누르거나 Esc 를 누르면 닫기
    document.addEventListener('click', (e) => { if (nav.open && !nav.contains(e.target)) nav.open = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') nav.open = false; });
  }).catch(() => { /* 메뉴 없이도 페이지는 동작 */ });
})();
