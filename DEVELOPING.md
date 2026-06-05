# 개발 가이드 (DEVELOPING)

> 사용 방법은 [README.md](README.md) 를 보세요. 이 문서는 빌드/기여용입니다.

## 개발 실행

```bash
npm install
npm start          # 개발 모드로 실행 (electron .)
```

> 게임 위에서 F9·F10 을 테스트하려면 **관리자 권한 터미널**에서 `npm start` 하세요.

## 테스트

```bash
npm test           # 단위 테스트 (node --test, 네트워크 불필요)
npm run smoke      # 실제 API로 전체 파이프라인 검증 (인터넷 필요)
```

## 빌드 (로컬)

```bash
npm run pack       # dist/win-unpacked/ 에 실행 가능한 앱 폴더만 생성 (권한 불필요)
npm run dist       # setup.exe + portable.exe 생성 (관리자 권한 또는 개발자 모드 필요)
```

> `npm run dist` 는 electron-builder 가 서명 도구를 풀 때 심볼릭 링크를 만들어,
> **관리자 권한 PowerShell** 또는 **Windows 개발자 모드**가 필요합니다. 보통은 아래 CI 릴리스를 쓰세요.

## 릴리스 (GitHub Actions 자동)

`v*` 태그를 푸시하면 `.github/workflows/release.yml` 이 `windows-latest`에서 빌드하여
`setup.exe` · `portable.exe` · `latest.yml` 을 해당 태그의 GitHub Release 에 자동 게시합니다.

```bash
# package.json 의 version 을 올린 뒤(예: 1.0.0 → 1.0.1) 커밋
git add package.json && git commit -m "release: v1.0.1"
git push

git tag v1.0.1 && git push origin v1.0.1   # → CI가 빌드 + 게시
```

설치본(setup.exe) 사용자는 앱의 **업데이트** 버튼으로 새 버전을 받아 재시작 한 번에 적용됩니다.

## 동작 원리 · 데이터 출처

전부 **공개 데이터**만 사용합니다 (API 키 없음). poe2db 스크래핑 없음.

| 용도 | 출처 |
|---|---|
| 시세 | poe.ninja PoE2 economy API (`exchange` / `stash` overview) — 공개 JSON, 무인증 |
| 한글 ↔ 영문 사전 | GGG 공식 거래 데이터: 영문(`pathofexile.com`) + 한글(`poe.game.daum.net`) realm |

한글↔영문은 두 realm 이 공유하는 안정적 키로 조인합니다.
- 통화·소모품류: 항목 `id` 직접 조인 → 100% 커버
- 유니크: 카테고리별 "유니크만" 인덱스 조인 → 100% 커버

인게임 인식:
- **F9**: 게임에 `Ctrl+C`(PowerShell SendKeys) → 클립보드 아이템 텍스트 파싱 → 카탈로그 조회
- **F10**: 커서 화면 캡처(GDI) → Windows 내장 한글 OCR(`Windows.Media.Ocr`) → 라인 파싱 → 조회

## 프로젝트 구조

```
src/
  main/                 메인 프로세스 (모든 네트워크 fetch → CORS 없음)
    config.js           엔드포인트 · 카테고리 매핑(실측 확정)
    main.js             앱 수명주기 · 창 · 트레이
    ipc.js              IPC 핸들러
    overlay.js          F9/F10 가격 툴팁 오버레이 창
    hotkey.js           전역 F9(단일) · F10(스캔) 단축키
    updater.js          GitHub Releases 자동 업데이트
    services/
      http.js           fetch 래퍼(타임아웃·재시도·동시성)
      normalize.js      문자열 정규화(검색/조인 공용)
      ninja.js          poe.ninja 클라이언트 + 가치 계산
      dictionary.js     GGG 한글↔영문 사전 빌더
      catalog.js        검색 카탈로그 빌더(+ 변형 dedup)
      search.js         검색 · 랭킹
      cache.js          디스크 캐시(TTL)
      store.js          상태 · 캐시 · priceCheck · scanRecipe
      itemtext.js       클립보드/OCR 아이템 텍스트 파싱(한/영)
      sendcopy.js       PowerShell SendKeys 로 Ctrl+C 전송
      ocr.js            화면 캡처 + Windows OCR
      elevation.js      관리자 권한 감지
  preload/preload.js    메인 창 contextBridge 안전 API
  overlay/              가격 툴팁 UI
  renderer/             검색 UI
```

## 보안

`contextIsolation` + `sandbox` + `nodeIntegration:false` + CSP. 렌더러는 화이트리스트된 IPC만 호출.
외부 API 응답(아이템 이름)은 모두 `textContent`/`createElement` 로 삽입 (innerHTML 미사용).
