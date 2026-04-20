/**
 * SpeedCam Guard — 프록시 서버 (v3)
 * axios 대신 native fetch 사용 (ECONNRESET 해결)
 */

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const NodeCache = require("node-cache");
const https     = require("https");
const http  = require("http");

const app  = express();
const PORT = process.env.PORT || 3001;

const CAMERA_API_URL =
  "http://api.data.go.kr/openapi/tn_pubr_public_unmanned_traffic_camera_api";

const cache = new NodeCache({ stdTTL: 1800 });

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/api", rateLimit({ windowMs: 60000, max: 60 }));

// ── 공공데이터포털용 HTTPS agent ──────────────────────────────────
// TLS 호환성 문제 해결
const publicDataAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: false,  // 공공API 인증서 이슈 대응
});

// ── HTTPS GET (fetch + https 직접 사용) ────────────────────────
function fetchPublicData(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (tryCount) => {
      const req = https.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SpeedCamGuard/1.0)",
          "Accept": "application/json",
        },
        timeout: 30000,
      }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON 파싱 실패: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on("error", (err) => {
        console.log(`[시도 ${tryCount}/${retries}] 오류:`, err.code || err.message);
        if (tryCount < retries) {
          setTimeout(() => attempt(tryCount + 1), 1000 * tryCount);
        } else {
          reject(err);
        }
      });

      req.on("timeout", () => {
        req.destroy();
        if (tryCount < retries) {
          setTimeout(() => attempt(tryCount + 1), 1000 * tryCount);
        } else {
          reject(new Error("타임아웃"));
        }
      });
    };
    attempt(1);
  });
}

// ── 엔드포인트 ────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.get("/api/status", (_, res) => res.json({
  cacheKeys:    cache.keys().length,
  uptime:       Math.round(process.uptime()),
  keyConfigured: !!process.env.DATA_GO_KR_KEY,
}));

app.get("/api/cameras", async (req, res) => {
  const { serviceKey, pageNo = "1", numOfRows = "1000", ctprvnNm = "", signguNm = "" } = req.query;
  const key = process.env.DATA_GO_KR_KEY || serviceKey;
  if (!key) return res.status(400).json({ error: "serviceKey가 없습니다." });

  const cacheKey = `p${pageNo}_${ctprvnNm}_${signguNm}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    let url = `${CAMERA_API_URL}?serviceKey=${encodeURIComponent(key)}&pageNo=${pageNo}&numOfRows=${numOfRows}&type=json`;
    if (ctprvnNm) url += `&ctprvnNm=${encodeURIComponent(ctprvnNm)}`;
    if (signguNm) url += `&signguNm=${encodeURIComponent(signguNm)}`;

    console.log("요청:", url.replace(key, "***"));
    const data = await fetchPublicData(url);
    const result = normalizeResponse(data);
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("최종 실패:", err.message);
    res.status(500).json({ error: "공공API 호출 실패", detail: err.message });
  }
});

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

    const d1 = await fetchPublicData(makeUrl(1));
    const first = normalizeResponse(d1);
    const totalCount = first.totalCount || 0;
    const pages = Math.ceil(totalCount / 1000);
    let all = [...(first.items || [])];

    for (let p = 2; p <= Math.min(pages, 50); p++) {
      const dp = await fetchPublicData(makeUrl(p));
      all = all.concat(normalizeResponse(dp).items || []);
      await new Promise(r => setTimeout(r, 500));
    }

    cache.set(cacheKey, all);
    res.json({ cameras: all, total: all.length, totalCount, fromCache: false });
  } catch (err) {
    console.error("전체 수집 실패:", err.message);
    res.status(500).json({ error: "전체 수집 실패", detail: err.message });
  }
});

app.post("/api/cache/clear", (_, res) => { cache.flushAll(); res.json({ ok: true }); });

function normalizeResponse(data) {
  const body = data?.response?.body;
  const header = data?.response?.header;

  if (header && header.resultCode !== "00") {
    throw new Error(`API 오류 [${header.resultCode}]: ${header.resultMsg}`);
  }

  if (body) {
    const raw = body.items?.item || body.items || [];
    const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return {
      totalCount: body.totalCount || items.length,
      items: items.map(normItem).filter(c => c.lat > 30 && c.lng > 120),
    };
  }
  return { totalCount: 0, items: [] };
}

function normItem(item) {
  return {
    id:      item.mngNo      || "",
    lat:     parseFloat(item.latitude  || 0),
    lng:     parseFloat(item.longitude || 0),
    type:    item.regltSe    || "",
    limit:   parseInt(item.lmttVlct   || 0) || 0,
    addr:    item.rdnmadr    || item.lnmadr || "",
    sido:    item.ctprvnNm   || "",
    sigungu: item.signguNm   || "",
  };
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════╗
║     SpeedCam Guard Proxy v3 (fetch)      ║
╠══════════════════════════════════════════╣
║  포트    : ${PORT}                           ║
║  키 설정 : ${process.env.DATA_GO_KR_KEY ? "✅ .env 로드됨" : "⚠️  없음"}          ║
║  HTTP    : native https (axios 제거)     ║
║  재시도  : 3회 자동                      ║
╚══════════════════════════════════════════╝
  `);
});
