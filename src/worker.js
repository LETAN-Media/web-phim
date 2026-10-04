// Cloudflare Worker: static frontend + Northflank MTProto gateway proxy.
// Video stays on Telegram. No R2 usage. Server-side signed URLs, legacy VPS fallback.
// Standards: guard clauses / early return, no nested if/else, full error handling.

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorJson(message, status = 500) {
  console.error(`[worker] error ${status}: ${message}`);
  return jsonResponse({ ok: false, error: message }, status);
}

function isLegacyFallbackEnabled(env) {
  const v = String(env.ENABLE_LEGACY_VIDEO_FALLBACK || "false").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

function legacyOrigin(env) {
  const o = String(env.LEGACY_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!o) return null;
  if (!/^https?:\/\//i.test(o)) return null;
  return o;
}

async function handleFeed(env, request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorJson("method not allowed", 405);
  }
  const data = await getStaticFeed(env, request);

  if (!data) {
    if (isLegacyFallbackEnabled(env)) {
      const origin = legacyOrigin(env);
      if (!origin) return jsonResponse({ ok: true, configured: false, count: 0, items: [] });
      try {
        const r = await fetch(`${origin}/api/feed`, { redirect: "follow" });
        if (!r.ok) return errorJson(`legacy feed HTTP ${r.status}`, 502);
        const legacy = await r.json();
        return jsonResponse(legacy);
      } catch (e) {
        console.error(`[worker] legacy feed failed: ${e && e.message}`);
        return errorJson("legacy feed error", 502);
      }
    }
    return jsonResponse({ ok: true, configured: true, count: 0, items: [] });
  }

  if (request.method === "HEAD") return new Response(null, { status: 200 });
  if (isNewGatewayEnabled(env)) {
    const chat = channelChatId(env);
    if (chat && Array.isArray(data.items)) {
      data.items = data.items.map((x) => ({
        ...x,
        chat_id: chat,
        message_id: x.mid,
        stream: `/api/play?mid=${x.mid}`,
      }));
    }
  }
  return jsonResponse(data);
}

// Compatibility: /api/tg-stream?mid= -> gateway play path; /api/tg-thumb?mid= -> static thumb.
async function handleLegacyTgApi(env, request, url) {
  const mid = url.searchParams.get("mid");
  if (!mid) return errorJson("missing mid", 400);
  const isThumb = url.pathname === "/api/tg-thumb";

  const items = await getFeedItems(env, request);
  if (items === null) {
    if (!isLegacyFallbackEnabled(env)) return errorJson("feed error", 502);
    return proxyLegacy(env, url.pathname + url.search);
  }
  const item = items.find((x) => String(x.mid) === String(mid));
  if (!item) {
    if (!isLegacyFallbackEnabled(env)) return errorJson("not found", 404);
    return proxyLegacy(env, url.pathname + url.search);
  }
  if (isThumb) {
    if (item.thumb) return Response.redirect(new URL(item.thumb, url).toString(), 302);
    if (!isLegacyFallbackEnabled(env)) return errorJson("not found", 404);
    return proxyLegacy(env, url.pathname + url.search);
  }
  return Response.redirect(new URL(`/api/play?mid=${item.mid}`, url).toString(), 302);
}

async function proxyLegacy(env, pathWithQuery) {
  const origin = legacyOrigin(env);
  if (!origin) return errorJson("legacy not configured", 502);
  try {
    return await fetch(`${origin}${pathWithQuery}`, { redirect: "follow" });
  } catch (e) {
    console.error(`[worker] legacy proxy failed: ${e && e.message}`);
    return errorJson("legacy error", 502);
  }
}

// ================= Gateway (Northflank MTProto) integration =================
// Video stays on Telegram. Worker signs URLs server-side (secret never reaches
// the browser) and proxies bytes without buffering. R2 is NOT used for video.

function gatewayOrigin(env) {
  const o = String(env.GATEWAY_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!o) return null;
  if (!/^https?:\/\//i.test(o)) return null;
  return o;
}

function channelChatId(env) {
  const v = String(env.CHANNEL_CHAT_ID || "").trim();
  if (!v) return null;
  if (!/^-?\d+$/.test(v)) return null;
  return v;
}

function urlTtlSeconds(env) {
  const n = Number(env.URL_TTL_SECONDS || 21600);
  if (!Number.isFinite(n) || n <= 0) return 21600;
  return Math.floor(n);
}

function isNewGatewayEnabled(env) {
  const v = String(env.ENABLE_NEW_TELEGRAM_GATEWAY ?? "true").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sigEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signMediaUrl(env, chat, mid) {
  const secret = String(env.STREAM_SIGNING_SECRET || "");
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + urlTtlSeconds(env);
  const sig = await hmacHex(secret, `${chat}:${mid}:${exp}`);
  return `/m/${chat}/${mid}?exp=${exp}&sig=${sig}`;
}

async function verifyMediaSig(env, chat, mid, exp, sig) {
  const secret = String(env.STREAM_SIGNING_SECRET || "");
  if (!secret) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0) return false;
  if (expNum <= Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(secret, `${chat}:${mid}:${expNum}`);
  return sigEqual(expected, String(sig || "").toLowerCase().trim());
}

async function getStaticFeed(env, request) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") return null;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL("/data/feed.json", request.url)));
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.error(`[worker] static feed failed: ${e && e.message}`);
    return null;
  }
}

async function getFeedItems(env, request) {
  const data = await getStaticFeed(env, request);
  if (!data) return null;
  return data.items || [];
}

// ================= R2 persistent cache (new account, S3 SigV4) =================
// R2 is a read-through cache only; Telegram stays master storage. On R2 MISS the
// bytes stream from the Northflank gateway (MTProto) and a background mirror is
// triggered fire-and-forget on the gateway. Old-account R2 is never touched.
// Credentials arrive as Worker secrets; missing config degrades to gateway-only.

function r2Config(env) {
  const endpoint = String(env.R2_NEW_ENDPOINT || "").trim().replace(/\/+$/, "");
  const accessKey = String(env.R2_NEW_ACCESS_KEY_ID || "").trim();
  const secretKey = String(env.R2_NEW_SECRET_ACCESS_KEY || "").trim();
  const bucket = String(env.R2_NEW_BUCKET || "").trim();
  if (!endpoint || !accessKey || !secretKey || !bucket) return null;
  if (!/^https:\/\//i.test(endpoint)) return null;
  return { endpoint, accessKey, secretKey, bucket };
}

function r2ObjectKey(chat, mid) {
  return `videos/${chat}/${mid}.mp4`;
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacRaw(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

function r2CanonicalUri(bucket, key) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `/${bucket}/${key.split("/").map(enc).join("/")}`;
}

// GET/HEAD one object. Returns the upstream Response (streamable body) or null
// on MISS/error/timeout. Never throws: R2 problems must never break playback.
async function r2Fetch(env, method, key, opts = {}) {
  const cfg = r2Config(env);
  if (!cfg) return null;
  try {
    const host = new URL(cfg.endpoint).host;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const canonicalUri = r2CanonicalUri(cfg.bucket, key);
    const headerMap = {
      host,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": amzDate,
    };
    const signedNames = Object.keys(headerMap).sort();
    const canonicalRequest = [
      method,
      canonicalUri,
      "",
      signedNames.map((n) => `${n}:${headerMap[n]}\n`).join(""),
      signedNames.join(";"),
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await sha256Hex(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");
    const kDate = await hmacRaw(new TextEncoder().encode(`AWS4${cfg.secretKey}`), dateStamp);
    const kRegion = await hmacRaw(kDate, "auto");
    const kService = await hmacRaw(kRegion, "s3");
    const kSigning = await hmacRaw(kService, "aws4_request");
    const signature = [...await hmacRaw(kSigning, stringToSign)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const headers = {
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": amzDate,
    };
    if (opts.range) headers.range = opts.range;
    const fetchOpts = { method, headers };
    if (opts.timeoutMs) fetchOpts.signal = AbortSignal.timeout(opts.timeoutMs);
    const resp = await fetch(`${cfg.endpoint}${canonicalUri}`, fetchOpts);
    if (!resp.ok) return null;
    return resp;
  } catch (e) {
    console.error(`[worker] r2 ${method} ${key} failed: ${e && e.message}`);
    return null;
  }
}

function withVideoSource(resp, source) {
  const headers = new Headers(resp.headers);
  headers.set("x-video-source", source);
  return new Response(resp.body, { status: resp.status, headers });
}

async function triggerMirror(env, origin, chat, mid, exp, sig) {
  try {
    const r = await fetch(
      `${origin}/v1/cache/${chat}/${mid}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`,
      { method: "POST" }
    );
    const body = await r.json().catch(() => ({}));
    console.log(`[worker] mirror trigger ${chat}/${mid}: http=${r.status} cache=${body.cache}`);
  } catch (e) {
    console.error(`[worker] mirror trigger failed: ${e && e.message}`);
  }
}

// ================= First-chunk prewarm (Cache API, internal only) =================
// On /api/play, background-fetch gateway bytes [0,512KB) then [512KB,2MB)
// into Cache API. Safari range probes inside that window are sliced from
// cache -> 206 with exact Content-Range/Length. Bounded (<=2MB), video body
// itself is never buffered on the hot path.
const PREWARM_PART0_END = 524288;
const PREWARM_PART1_END = 2097152;

function prewarmKey(chat, mid, part) {
  return `https://prewarm.internal/v/${chat}/${mid}/${part}`;
}

function parseTotalFromContentRange(header) {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function prewarmParts(env, origin, chat, mid, exp, sig) {
  const jobs = [
    [0, PREWARM_PART0_END, "0"],
    [PREWARM_PART0_END, PREWARM_PART1_END, "1"],
  ];
  for (const [s, e, part] of jobs) {
    const key = prewarmKey(chat, mid, part);
    try {
      const hit = await caches.default.match(key);
      if (hit) continue;
      const r = await fetch(
        `${origin}/v1/video/${chat}/${mid}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`,
        { headers: { range: `bytes=${s}-${e - 1}` } }
      );
      if (!r.ok || r.status !== 206) continue;
      const buf = await r.arrayBuffer();
      if (!buf || buf.byteLength === 0) continue;
      const total = parseTotalFromContentRange(r.headers.get("content-range")) || e;
      const stored = new Response(buf, {
        status: 200,
        headers: {
          "content-type": r.headers.get("content-type") || "video/mp4",
          "x-prewarm-start": String(s),
          "x-prewarm-total": String(total),
          "cache-control": "private, max-age=21600",
        },
      });
      await caches.default.put(key, stored);
    } catch (err) {
      console.error(`[worker] prewarm ${chat}/${mid}/${part} failed: ${err && err.message}`);
    }
  }
}

// On play: keep the 2MB edge prewarm, then fire the background mirror so the
// video is persisted to R2 for future viewers. Both are fire-and-forget.
async function prewarmOrMirror(env, origin, chat, mid, exp, sig) {
  await prewarmParts(env, origin, chat, mid, exp, sig);
  await triggerMirror(env, origin, chat, mid, exp, sig);
}

async function serveFromPrewarm(chat, mid, start, end) {
  if (start < 0 || end < start || end >= PREWARM_PART1_END) return null;
  const need0 = start < PREWARM_PART0_END;
  const need1 = end >= PREWARM_PART0_END;
  try {
    const [p0, p1] = await Promise.all([
      need0 ? caches.default.match(prewarmKey(chat, mid, "0")) : null,
      need1 ? caches.default.match(prewarmKey(chat, mid, "1")) : null,
    ]);
    if (need0 && !p0) return null;
    if (need1 && !p1) return null;
    const bufs = [];
    let total = null;
    let cursor = 0;
    for (const [resp, partStart] of [[p0, 0], [p1, PREWARM_PART0_END]]) {
      if (!resp) continue;
      const t = Number(resp.headers.get("x-prewarm-total") || 0);
      if (Number.isFinite(t) && t > 0) total = t;
      const ab = await resp.arrayBuffer();
      bufs.push({ start: partStart, bytes: new Uint8Array(ab) });
      cursor = partStart + ab.byteLength;
    }
    if (total === null) return null;
    if (end >= total) return null;
    const out = new Uint8Array(end - start + 1);
    let filled = 0;
    for (const b of bufs) {
      const s = Math.max(start, b.start);
      const e = Math.min(end, b.start + b.bytes.length - 1);
      if (e < s) continue;
      out.set(b.bytes.subarray(s - b.start, e - b.start + 1), filled);
      filled += e - s + 1;
    }
    if (filled !== out.length) return null;
    return new Response(out, {
      status: 206,
      headers: {
        "content-type": (p0 || p1).headers.get("content-type") || "video/mp4",
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${total}`,
        "content-length": String(out.length),
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error(`[worker] prewarm serve failed: ${err && err.message}`);
    return null;
  }
}

// GET /api/play?mid=<n>[&format=json] — fresh signed URL at play time, 302 by default.
async function handlePlay(env, request, url, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") return errorJson("method not allowed", 405);
  const mid = url.searchParams.get("mid");
  if (!mid || !/^\d+$/.test(mid)) return errorJson("invalid mid", 400);
  if (!isNewGatewayEnabled(env)) {
    if (!isLegacyFallbackEnabled(env)) return errorJson("gateway disabled", 503);
    const origin = legacyOrigin(env);
    if (!origin) return errorJson("legacy not configured", 502);
    return Response.redirect(`${origin}/api/tg-stream?mid=${mid}`, 302);
  }
  const chat = channelChatId(env);
  if (!chat) return errorJson("channel not configured", 500);
  const items = await getFeedItems(env, request);
  if (items === null) return errorJson("feed error", 502);
  const found = items.some((x) => String(x.mid) === String(mid));
  if (!found) return errorJson("not found", 404);
  const signed = await signMediaUrl(env, chat, mid);
  if (!signed) return errorJson("signing not configured", 500);
  try {
    const origin = gatewayOrigin(env);
    const exp = new URL(signed, url).searchParams.get("exp") || "";
    const sig = new URL(signed, url).searchParams.get("sig") || "";
    if (origin && exp && sig && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(prewarmOrMirror(env, origin, chat, mid, exp, sig));
    }
  } catch (err) {
    console.error(`[worker] prewarm schedule failed: ${err && err.message}`);
  }
  if (url.searchParams.get("format") === "json") return jsonResponse({ ok: true, url: signed });
  return Response.redirect(new URL(signed, url).toString(), 302);
}

// GET/HEAD /m/<chat>/<mid>?exp=..&sig=.. — verify then proxy gateway, fallback legacy.
async function handleMediaProxy(env, request, chat, mid, url, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") return errorJson("method not allowed", 405);
  if (!/^-?\d+$/.test(chat || "") || !/^\d+$/.test(mid || "")) return errorJson("invalid path", 400);
  const configuredChat = channelChatId(env);
  if (!configuredChat || chat !== configuredChat) return errorJson("chat not allowed", 403);
  const ok = await verifyMediaSig(env, chat, mid, url.searchParams.get("exp"), url.searchParams.get("sig"));
  if (!ok) return errorJson("invalid or expired signature", 403);
  const origin = gatewayOrigin(env);
  if (!origin) return errorJson("gateway not configured", 500);

  const range = request.headers.get("range");
  const inm = request.headers.get("if-none-match");

  // Source order: R2 persistent cache -> Northflank/Telegram -> legacy VPS.
  const exp = url.searchParams.get("exp") || "";
  const sig = url.searchParams.get("sig") || "";

  // Fast path 1: small ranges inside the 2MB prewarm window come from Cache API.
  if (request.method === "GET") {
    const probe = /^bytes=(\d+)-(\d+)$/.exec((range || "").trim());
    if (probe) {
      const start = Number(probe[1]);
      const end = Number(probe[2]);
      if (end >= start && end < PREWARM_PART1_END) {
        const cached = await serveFromPrewarm(chat, mid, start, end);
        if (cached) return withVideoSource(cached, "TELEGRAM");
      }
    }
  }

  // Fast path 2: R2 persistent cache (HEAD->GET keeps misses at one lookup).
  const r2Key = r2ObjectKey(chat, mid);
  const r2Resp = await r2Fetch(env, request.method, r2Key, {
    range: range || undefined,
    timeoutMs: 8000,
  });
  if (r2Resp) return withVideoSource(r2Resp, "R2");

  // MISS: stream from the gateway now; trigger the background mirror so
  // future viewers hit R2. Never make the user wait for the mirror.
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(triggerMirror(env, origin, chat, mid, exp, sig));
  }

  const upstream = `${origin}/v1/video/${chat}/${mid}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  const headers = new Headers();
  if (range) headers.set("range", range);
  if (inm) headers.set("if-none-match", inm);
  let upstreamResp = null;
  try {
    upstreamResp = await fetch(upstream, { method: request.method, headers, redirect: "follow" });
  } catch (e) {
    console.error(`[worker] gateway fetch failed: ${e && e.message}`);
    upstreamResp = null;
  }
  if (upstreamResp && upstreamResp.ok) return withVideoSource(upstreamResp, "TELEGRAM");
  const status = upstreamResp ? upstreamResp.status : 0;
  console.error(`[worker] gateway HTTP ${status}, trying legacy fallback`);
  if (!isLegacyFallbackEnabled(env)) return errorJson("gateway error", 502);
  const legacy = legacyOrigin(env);
  if (!legacy) return errorJson("gateway error", 502);
  const loc = `${legacy}/api/tg-stream?mid=${mid}`;
  return new Response(null, {
    status: 302,
    headers: { location: loc, "x-video-source": "LEGACY" },
  });
}

// ================= View counting (Cloudflare KV) =================
// Mỗi phim Telegram có điểm riêng, mỗi lượt bấm Phát +1 toàn site.
// Điểm khởi đầu khác nhau theo mid (ổn định, frontend tính giống hệt),
// lượt xem thật cộng dồn từ đó. Thiếu KV -> 501, frontend giữ điểm seed.

function seedViewsFor(mid) {
  const n = Number(mid);
  if (!Number.isFinite(n)) return 20;
  return 15 + ((Math.abs(Math.floor(n)) * 53) % 70);
}

async function readViewCounts(env) {
  if (!env.VIEWS || typeof env.VIEWS.get !== "function") return null;
  try {
    const raw = await env.VIEWS.get("v1");
    if (!raw) return {};
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch (e) {
    console.error(`[worker] views read failed: ${e && e.message}`);
    return {};
  }
}

async function writeViewCounts(env, map) {
  try {
    await env.VIEWS.put("v1", JSON.stringify(map));
    return true;
  } catch (e) {
    console.error(`[worker] views write failed: ${e && e.message}`);
    return false;
  }
}

// GET /api/views — điểm mọi video trong feed (tự seed video mới).
async function handleViewsGet(env, request) {
  if (request.method !== "GET" && request.method !== "HEAD") return errorJson("method not allowed", 405);
  const counts = await readViewCounts(env);
  if (counts === null) return jsonResponse({ ok: false, error: "views not configured" }, 501);
  const items = await getFeedItems(env, request);
  if (items === null) return errorJson("feed error", 502);
  let dirty = false;
  for (const x of items) {
    const mid = String(x.mid);
    if (!Number.isFinite(Number(counts[mid]))) {
      counts[mid] = seedViewsFor(mid);
      dirty = true;
    }
  }
  if (dirty) await writeViewCounts(env, counts);
  const views = {};
  for (const x of items) views[String(x.mid)] = Number(counts[String(x.mid)]) || 0;
  if (request.method === "HEAD") return new Response(null, { status: 200 });
  return jsonResponse({ ok: true, views });
}

// POST /api/views/hit?mid=<n> — +1 lượt xem, chỉ nhận mid có trong feed.
async function handleViewsHit(env, request, url) {
  if (request.method !== "POST") return errorJson("method not allowed", 405);
  const mid = String(url.searchParams.get("mid") || "");
  if (!/^\d+$/.test(mid)) return errorJson("invalid mid", 400);
  const items = await getFeedItems(env, request);
  if (items === null) return errorJson("feed error", 502);
  const found = items.some((x) => String(x.mid) === String(mid));
  if (!found) return errorJson("not found", 404);
  const counts = await readViewCounts(env);
  if (counts === null) return jsonResponse({ ok: false, error: "views not configured" }, 501);
  const cur = Number(counts[mid]);
  counts[mid] = (Number.isFinite(cur) ? Math.floor(cur) : seedViewsFor(mid)) + 1;
  await writeViewCounts(env, counts);
  return jsonResponse({ ok: true, mid, views: counts[mid] });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feed") return handleFeed(env, request);
    if (url.pathname === "/api/views") return handleViewsGet(env, request);
    if (url.pathname === "/api/views/hit") return handleViewsHit(env, request, url);
    if (url.pathname === "/api/play") return handlePlay(env, request, url, ctx);
    if (url.pathname.startsWith("/m/")) {
      const parts = url.pathname.slice(3).split("/").filter(Boolean);
      if (parts.length !== 2) return errorJson("invalid path", 400);
      return handleMediaProxy(env, request, parts[0], parts[1], url, ctx);
    }
    if (url.pathname === "/api/tg-stream" || url.pathname === "/api/tg-thumb") {
      return handleLegacyTgApi(env, request, url);
    }
    if (url.pathname === "/api/health") return jsonResponse({ ok: true });

    // Static frontend fallback. Unmatched paths must be a REAL HTTP 404
    // (public/404.html via not_found_handling=404-page) — never a fake 200.
    // HTML responses get X-Robots-Tag: noindex, follow (belt & braces with
    // the <meta> inside 404.html). API/streaming routes are handled above.
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return errorJson("static assets binding missing", 500);
    }
    try {
      const resp = await env.ASSETS.fetch(request);
      const ctype = resp.headers.get("content-type") || "";
      if (!ctype.includes("text/html")) return resp;
      const headers = new Headers(resp.headers);
      headers.set("x-robots-tag", "noindex, follow");
      return new Response(resp.body, { status: resp.status, headers });
    } catch (e) {
      console.error(`[worker] assets fetch failed: ${e && e.message}`);
      return errorJson("assets error", 502);
    }
  },
};
