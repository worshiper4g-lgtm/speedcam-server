/**
 * SpeedCam Guard — 프록시 서버
 * 공공데이터포털 전국무인교통단속카메라표준데이터 API를 중계합니다.
 * 
 * 실행: node index.js
 * 포트: 3001 (기본값, .env로 변경 가능)
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const axios      = require("axios");
const rateLimit  = require("express-rate-limit");
const NodeCache  = require("node-cache");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── 공공데이터포털 API 상수 ───────────────────────────────────────
// data.go.kr → 전국무인교통단속카메라표준데이터 (15028200)
// 오픈API 신청 후 발급받은 서비스키(Decoding)를 사용합니다.
const CAMERA_API_URL =
  "https://apis.data.go.kr/3710000/cameraFormsOfSafety/getCameraList";

// ── 캐시 (30분) ───────────────────────────────────────────────────
const cache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

// ── 미들웨어 ──────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "*",  // 프로덕션에선 도메인 지정 권장
  methods: ["GET", "POST"],
}));
app.use(express.json());

// ── Rate Limit (분당 60회) ────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." },
});
app.use("/api", limiter);

// ── 헬스체크 ─────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ── 단일 페이지 조회 ─────────────────────────────────────────────
/**
 * GET /api/cameras
 * Query: serviceKey, pageNo, numOfRows, ctprvnNm(시도명 선택), signguNm(시군구명 선택)
 */
app.get("/api/cameras", async (req, res) => {
  const {
    serviceKey,
    pageNo    = 1,
    numOfRows = 1000,
    ctprvnNm  = "",   // 예: 경상남도
    signguNm  = "",   // 예: 창원시
  } = req.query;

  // 서버에 저장된 키 없으면 클라이언트 키 사용
  const key = process.env.DATA_GO_KR_KEY || serviceKey;
  if (!key) return res.status(400).json({ error: "serviceKey가 없습니다." });

  const cacheKey = `cameras_${ctprvnNm}_${signguNm}_p${pageNo}_n${numOfRows}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const params = {
      serviceKey: key,
      numOfRows:  parseInt(numOfRows),
      pageNo:     parseInt(pageNo),
      type:       "json",
    };
    if (ctprvnNm) params.ctprvnNm = ctprvnNm;
    if (signguNm) params.signguNm = signguNm;

    const { data } = await axios.get(CAMERA_API_URL, {
      params,
      timeout: 15000,
    });

    // 공공데이터포털 응답 정규화
    const result = normalizeResponse(data);
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: "공공API 호출 실패",
      detail: err.message,
      hint: status === 401 || status === 403
        ? "서비스키를 확인하세요 (Decoding 키 사용)"
        : "잠시 후 다시 시도하세요.",
    });
  }
});

// ── 전체 페이지 자동 수집 ─────────────────────────────────────────
/**
 * GET /api/cameras/all
 * 전체 데이터를 페이지네이션으로 자동 수집해서 반환합니다.
 * Query: serviceKey, ctprvnNm(선택), signguNm(선택)
 * 
 * ⚠️  전국 데이터는 수만 건 → 시도명으로 필터 권장
 */
app.get("/api/cameras/all", async (req, res) => {
  const { serviceKey, ctprvnNm = "", signguNm = "" } = req.query;
  const key = process.env.DATA_GO_KR_KEY || serviceKey;
  if (!key) return res.status(400).json({ error: "serviceKey가 없습니다." });

  const cacheKey = `all_${ctprvnNm}_${signguNm}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ cameras: cached, total: cached.length, fromCache: true });

  try {
    // 1페이지 먼저 요청해서 totalCount 파악
    const firstParams = { serviceKey: key, numOfRows: 1000, pageNo: 1, type: "json" };
    if (ctprvnNm) firstParams.ctprvnNm = ctprvnNm;
    if (signguNm) firstParams.signguNm = signguNm;

    const { data: firstData } = await axios.get(CAMERA_API_URL, { params: firstParams, timeout: 15000 });
    const first = normalizeResponse(firstData);
    const totalCount = first.totalCount || 0;
    const totalPages = Math.ceil(totalCount / 1000);

    let all = [...(first.items || [])];

    // 나머지 페이지 순차 요청 (공공API 부하 방지)
    for (let p = 2; p <= Math.min(totalPages, 50); p++) {
      const params = { serviceKey: key, numOfRows: 1000, pageNo: p, type: "json" };
      if (ctprvnNm) params.ctprvnNm = ctprvnNm;
      if (signguNm) params.signguNm = signguNm;
      const { data } = await axios.get(CAMERA_API_URL, { params, timeout: 15000 });
      const norm = normalizeResponse(data);
      all = all.concat(norm.items || []);
      await sleep(200); // 공공API 부하 방지
    }

    cache.set(cacheKey, all);
    res.json({ cameras: all, total: all.length, totalCount, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: "전체 수집 실패", detail: err.message });
  }
});

// ── 캐시 초기화 ───────────────────────────────────────────────────
app.post("/api/cache/clear", (req, res) => {
  cache.flushAll();
  res.json({ ok: true, message: "캐시 초기화 완료" });
});

// ── 서버 상태 ─────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    cacheKeys: cache.keys().length,
    uptime: Math.round(process.uptime()),
    keyConfigured: !!process.env.DATA_GO_KR_KEY,
    apiEndpoint: CAMERA_API_URL,
  });
});

// ── 응답 정규화 ───────────────────────────────────────────────────
function normalizeResponse(data) {
  // 공공데이터포털 응답은 기관마다 구조가 조금씩 다름
  try {
    // 표준 구조: response.body.items.item[]
    const body = data?.response?.body;
    if (body) {
      const raw = body.items?.item || body.items || [];
      const items = Array.isArray(raw) ? raw : [raw];
      return {
        totalCount: body.totalCount || items.length,
        items: items.map(normItem),
      };
    }
    // 일부 기관 구조: data[].item[]
    if (Array.isArray(data)) {
      return { totalCount: data.length, items: data.map(normItem) };
    }
    return { totalCount: 0, items: [] };
  } catch {
    return { totalCount: 0, items: [] };
  }
}

function normItem(item) {
  return {
    id:      item.mngNo       || item.id     || "",
    lat:     parseFloat(item.latitude  || item.lat  || item.위도 || 0),
    lng:     parseFloat(item.longitude || item.lng  || item.경도 || 0),
    type:    item.regltSe     || item.단속구분  || "",
    limit:   parseInt(item.lmttVlct || item.제한속도 || 0) || 0,
    addr:    item.rdnmadr     || item.lnmadr  || item.소재지도로명주소 || item.설치장소 || "",
    sido:    item.ctprvnNm    || item.시도명   || "",
    sigungu: item.signguNm    || item.시군구명  || "",
    road:    item.ronaNum     || item.도로노선명 || "",
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 서버 시작 ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║      SpeedCam Guard 프록시 서버 시작     ║
╠══════════════════════════════════════════╣
║  포트    : ${PORT}                           ║
║  API URL : data.go.kr/15028200           ║
║  키 설정 : ${process.env.DATA_GO_KR_KEY ? "✅ .env에서 로드됨" : "⚠️  .env 없음 (클라이언트 키 사용)"}  ║
╚══════════════════════════════════════════╝
  `);
});
