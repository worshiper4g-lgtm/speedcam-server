/**
 * SpeedCam Guard — 프록시 서버
 * 전국무인교통단속카메라표준데이터 API 중계
 * 실행: node index.js
 */

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const axios     = require("axios");
const rateLimit = require("express-rate-limit");
const NodeCache = require("node-cache");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── 올바른 API 엔드포인트 (HTTPS) ───────────────────────────────
const CAMERA_API_URL =
  "https://api.data.go.kr/openapi/tn_pubr_public_unmanned_traffic_camera_api";

// ── 캐시 30분 ────────────────────────────────────────────────────
const cache = new NodeCache({ stdTTL: 1800 });

// ── 미들웨어 ──────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/api", rateLimit({ windowMs: 60000, max: 60 }));

// ── 헬스체크 ─────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() })
);

// ── 서버 상태 ─────────────────────────────────────────────────────
app.get("/api/status", (_, res) =>
  res.json({
    cacheKeys:    cache.keys().length,
    uptime:       Math.round(process.uptime()),
    keyConfigured: !!process.env.DATA_GO_KR_KEY,
    apiEndpoint:  CAMERA_API_URL,
  })
);

// ── 카메라 조회 ───────────────────────────────────────────────────
app.get("/api/cameras", async (req, res) => {
  const {
    serviceKey,
    pageNo    = "1",
    numOfRows = "1000",
    ctprvnNm  = "",
    signguNm  = "",
  } = req.query;

  const key = process.env.DATA_GO_KR_KEY || serviceKey;
  if (!key) return res.status(400).json({ error: "serviceKey가 없습니다." });

  const cacheKey = `p${pageNo}_${ctprvnNm}_${signguNm}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // serviceKey는 URL에 직접 붙여야 공공데이터포털이 인식함
    let url = `${CAMERA_API_URL}?serviceKey=${encodeURIComponent(key)}&pageNo=${pageNo}&numOfRows=${numOfRows}&type=json`;
    if (ctprvnNm) url += `&ctprvnNm=${encodeURIComponent(ctprvnNm)}`;
    if (signguNm) url += `&signguNm=${encodeURIComponent(signguNm)}`;

    console.log("API 요청:", url.replace(key, "***KEY***"));

    const { data } = await axios.get(url, { timeout: 20000 });
    const result = normalizeResponse(data);
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("API 오류:", err.message);
    res.status(500).json({
      error: "공공API 호출 실패",
      detail: err.message,
    });
  }
});

// ── 전체 자동 수집 ────────────────────────────────────────────────
app.get("/api/cameras/all", async (req, res) => {
  const { serviceKey, ctprvnNm = "", signguNm = "" } = req.query;
  const key = process.env.DATA_GO_KR_KEY || serviceKey;
  if (!key) return res.status(400).json({ error: "serviceKey가 없습니다." });

  const cacheKey = `all_${ctprvnNm}_${signguNm}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ cameras: cached, total: cached.length, fromCache: true });

  try {
    const makeUrl = (page) => {
      let u = `${CAMERA_API_URL}?serviceKey=${encodeURIComponent(key)}&pageNo=${page}&numOfRows=1000&type=json`;
      if (ctprvnNm) u += `&ctprvnNm=${encodeURIComponent(ctprvnNm)}`;
      if (signguNm) u += `&signguNm=${encodeURIComponent(signguNm)}`;
      return u;
    };

    const { data: d1 } = await axios.get(makeUrl(1), { timeout: 20000 });
    const first = normalizeResponse(d1);
    const totalCount = first.totalCount || 0;
    const pages = Math.ceil(totalCount / 1000);
    let all = [...(first.items || [])];

    for (let p = 2; p <= Math.min(pages, 50); p++) {
      const { data: dp } = await axios.get(makeUrl(p), { timeout: 20000 });
      all = all.concat(normalizeResponse(dp).items || []);
      await new Promise(r => setTimeout(r, 300));
    }

    cache.set(cacheKey, all);
    res.json({ cameras: all, total: all.length, totalCount, fromCache: false });
  } catch (err) {
    console.error("전체 수집 오류:", err.message);
    res.status(500).json({ error: "전체 수집 실패", detail: err.message });
  }
});

// ── 캐시 초기화 ───────────────────────────────────────────────────
app.post("/api/cache/clear", (_, res) => {
  cache.flushAll();
  res.json({ ok: true });
});

// ── 응답 정규화 ───────────────────────────────────────────────────
function normalizeResponse(data) {
  const body = data?.response?.body;
  if (body) {
    const header = data?.response?.header;
    if (header?.resultCode !== "00") {
      throw new Error(`API 오류 [${header?.resultCode}]: ${header?.resultMsg}`);
    }
    const raw = body.items?.item || body.items || [];
    const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return {
      totalCount: body.totalCount || items.length,
      items: items.map(normItem).filter(c => c.lat > 30 && c.lng > 120),
    };
  }
  if (Array.isArray(data)) {
    return { totalCount: data.length, items: data.map(normItem) };
  }
  return { totalCount: 0, items: [] };
}

function normItem(item) {
  return {
    id:      item.mngNo      || "",
    lat:     parseFloat(item.latitude  || item.lat  || item.위도 || 0),
    lng:     parseFloat(item.longitude || item.lng  || item.경도 || 0),
    type:    item.regltSe    || item.단속구분  || "",
    limit:   parseInt(item.lmttVlct   || item.제한속도 || 0) || 0,
    addr:    item.rdnmadr    || item.lnmadr  || item.설치장소 || "",
    sido:    item.ctprvnNm   || "",
    sigungu: item.signguNm   || "",
  };
}

// ── 서버 시작 ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║      SpeedCam Guard 프록시 서버 시작     ║
╠══════════════════════════════════════════╣
║  포트    : ${PORT}                           ║
║  키 설정 : ${process.env.DATA_GO_KR_KEY ? "✅ .env 로드됨" : "⚠️  없음 (클라이언트 키 사용)"}     ║
╚══════════════════════════════════════════╝
  `);
});
