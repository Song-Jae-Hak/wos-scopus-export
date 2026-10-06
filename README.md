# WoS · Scopus 논문 반출 도구

도서관 연구성과 업무용 로컬 웹 도구 두 가지를 묶은 저장소입니다.

| 기능 | 하는 일 |
|---|---|
| **Web of Science 논문 반출** | 등록일(Index Date) 기간을 넣으면 크롬을 자동으로 조작해 WoS 고급 검색 결과를 Excel(Full Record)로 받고, 맨 앞에 RG(받은 날짜) 열을 붙여 저장 |
| **Scopus 논문 EID 반출** | 등록일 기간을 넣으면 Scopus Search API 로 Final · Article in Press 논문 EID 를 모아, Scopus 내보내기 양식(29열)으로 N개씩 잘라 지정 폴더에 저장 |

Windows 10/11 + Node.js 20 이상에서 동작합니다. 서버는 이 PC(127.0.0.1)에서만 접속되며 외부에 열리지 않습니다.

## 실행

1. [Node.js](https://nodejs.org) LTS 설치
2. **`start.bat` 더블클릭** — 처음엔 필요한 패키지를 자동 설치하고(`npm install`), `.env` 가 없으면 `.env.example` 을 복사해 만듭니다.
   서버가 뜨면 브라우저에서 http://localhost:4100 이 열립니다.
3. 끌 때는 서버 창을 닫거나 `stop-server.bat` 실행.

직접 실행하려면:

```bash
npm install
node server.js
```

## 설정 (.env)

| 키 | 설명 |
|---|---|
| `SCOPUS_API_KEY` | [Elsevier Developer Portal](https://dev.elsevier.com) 에서 발급. 비워 두면 Scopus 화면에서 임시 키를 넣어 쓸 수 있음 |
| `PORT` | 기본 4100 |

WoS 는 키가 필요 없습니다. 대신 **기관 구독 IP(교내망/VPN)** 에서 WoS 에 접속되는 PC 여야 합니다.
Scopus API 도 기관 IP 에서 호출해야 전체 결과가 나옵니다.

`.env` 와 각 기능의 `data/`(저장 폴더·쿼리 기억, 자동화 크롬 프로필)는 `.gitignore` 에 들어 있어 저장소에 올라가지 않습니다.

## Scopus 논문 EID 반출

1. **기간** — 시작일·마지막일(YYYYMMDD)을 넣거나 빠른 버튼(지난 7일/14일/반월/지난달/이번 달)을 누릅니다.
   이 PC 시간대 기준으로 시작일 00:00:00, 마지막일 23:59:59 의 epoch(초)로 바뀌어 `ORIG-LOAD-DATE AFT/BEF` 에 들어갑니다.
2. **쿼리** — 템플릿을 자유롭게 고칠 수 있고, `{STAGE}` `{START}` `{END}` 자리만 자동으로 채워집니다.
   Final / aip 두 쿼리를 **각각 따로** 호출합니다. 고친 템플릿은 기억합니다.
   기본 템플릿은 부산대학교 AF-ID 들이므로 다른 기관은 자기 기관 AF-ID 로 바꿔 쓰세요.
3. **결과** — Final / Article in Press 건수, 합계(중복 EID 는 한 번만), 저장될 파일 수, 목록 미리보기.
4. **잘라서 저장** — 지정 폴더에 파일당 N개(기본 40)씩 `파일이름_01`, `_02` … 로 저장합니다.
   - 열은 Scopus 내보내기 양식 29개(Authors … EID)이고 **EID 열만 채웁니다.**
   - 형식은 **CSV(기본)** 또는 xlsx. CSV 는 Scopus 내보내기와 같게 UTF-8(BOM)에 모든 칸을 큰따옴표로 감쌉니다.
   - "Final / aip 따로 저장"을 켜면 `_Final_01`, `_aip_01` 처럼 나눠 저장합니다.
   - 같은 이름 파일이 있으면 덮어쓰지 않고 `(2)` 를 붙입니다.
   - 폴더·개수·형식은 `features/scopus/data/settings.json` 에 기억됩니다.

참고: Scopus Search API 는 한 쿼리당 앞 5,000건까지만 넘겨볼 수 있어서, 그보다 많으면 경고가 뜹니다 (기간을 나눠서 불러오세요).

## Web of Science 논문 반출

크롬을 자동으로 조작(Selenium)해서 WoS 고급 검색 → Index Date(등록일) 기간 → Excel(Full Record) 내보내기를 대신 합니다.

1. **기간** — 시작일·마지막일을 YYYYMMDD 로 넣습니다. WoS 에는 YYYY-MM-DD 로 입력됩니다 (Index Date > Custom).
2. **쿼리** — 고친 검색식은 저장되어 다음에도 불러옵니다. "기본 쿼리로 되돌리기"로 원래 식 복원.
   기본 검색식은 부산대학교 주소(AD) 조건이므로 다른 기관은 바꿔 쓰세요.
3. **실행** — 자동화 크롬 창이 떠서 검색·내보내기를 합니다. 실행 중에는 그 창을 건드리지 마세요.
   - 1000건이 넘으면 1~1000, 1001~2000 … 으로 나눠 받아 **한 파일로 합칩니다.**
   - 결과 파일 맨 앞에 **RG** 열(받은 날짜 YYYYMMDD)을 붙여 저장 폴더에 `WoS_시작일-마지막일_받은날.xlsx` 로 저장.
   - 기관 IP 가 아니라 로그인 화면이 뜨면, 자동화 크롬 창에서 **직접 로그인**하면 이어서 진행합니다 (최대 5분 대기).

**크롬 버전** — 실행할 때마다 설치된 크롬 버전을 읽어서 **(주 버전 − 1)** 의 자동화 전용 크롬(Chrome for Testing)과
같은 버전의 chromedriver 를 Selenium Manager 가 자동으로 받아 씁니다 (처음 한 번 약 150MB, `%USERPROFILE%\.cache\selenium` 에 보관).
크롬이 업데이트되면 다음 실행 때 알아서 새 버전을 받습니다. 평소 쓰는 크롬과는 분리되어 있습니다.

**크롬 창 정리** — 반출이 끝나면(정상 완료·오류·중지 모두) 자동화 크롬 창과 드라이버를 완전히 끕니다.
도중에 서버가 끊겨 창이 남았다면, 다음 반출을 시작할 때 전용 프로필을 쓰는 자동화 크롬만 골라 정리합니다 (평소 쓰는 크롬은 건드리지 않음).

**느린 사이트 대비** — "사이트가 느릴 때"에서 대기 시간을 2배·3배로 늘릴 수 있고, 단계가 실패하면 자동으로 최대 3번 다시 시도합니다.

**사람 속도로 동작** — 창이 보이는 일반 브라우저로, 클릭 전 마우스 이동·무작위 쉼·끊어 입력하는 방식으로 동작합니다.
자동화 표시를 숨기는 위장은 하지 않습니다. 기관 구독 약관(Clarivate)의 범위 안에서, 업무에 필요한 만큼만 사용하세요.

## 폴더 구성

```
server.js              서버 — features/<id>/ 를 자동으로 찾아 /<id>/ 에 붙임
start.bat              실행 (ASCII 전용 — cmd 가 ANSI 코드페이지로 읽기 때문)
stop-server.bat        종료 (이 포트를 쓰는 프로세스만)
public/                홈 화면, 공통 CSS·메뉴 (shared/)
lib/local-files.js     설정 파일 저장, 윈도우 폴더 선택 창, 탐색기 열기
lib/pick-folder.ps1    폴더 선택 창 (브라우저 뒤에 숨지 않게 맨 앞에 띄움)
features/scopus/       Scopus 화면(public/) + API 프록시·저장(router.js)
features/wos/          WoS 화면(public/) + 작업 관리(router.js) + 크롬 자동화(wos-export.js)
```

새 기능은 `features/<id>/` 에 `feature.json` · `public/` · (필요하면) `router.js` 를 넣으면 홈에 카드로 나타납니다.
