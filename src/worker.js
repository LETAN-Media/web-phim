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
      ctx.waitUntil(prewarmParts(env, origin, chat, mid, exp, sig));
    }
  } catch (err) {
    console.error(`[worker] prewarm schedule failed: ${err && err.message}`);
  }
  if (url.searchParams.get("format") === "json") return jsonResponse({ ok: true, url: signed });
  return Response.redirect(new URL(signed, url).toString(), 302);
}

// GET/HEAD /m/<chat>/<mid>?exp=..&sig=.. — verify then proxy gateway, fallback legacy.
async function handleMediaProxy(env, request, chat, mid, url) {
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

  // Fast path: explicit small ranges inside the prewarm window are sliced
  // from Cache API (proves total from cached headers; falls through to
  // upstream proxy on any miss). Suffix/open ranges always proxy.
  if (request.method === "GET") {
    const probe = /^bytes=(\d+)-(\d+)$/.exec((range || "").trim());
    if (probe) {
      const start = Number(probe[1]);
      const end = Number(probe[2]);
      if (end >= start && end < PREWARM_PART1_END) {
        const cached = await serveFromPrewarm(chat, mid, start, end);
        if (cached) return cached;
      }
    }
  }

  const upstream = `${origin}/v1/video/${chat}/${mid}?exp=${encodeURIComponent(
    url.searchParams.get("exp") || ""
  )}&sig=${encodeURIComponent(url.searchParams.get("sig") || "")}`;
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
  if (upstreamResp && upstreamResp.ok) return upstreamResp;
  const status = upstreamResp ? upstreamResp.status : 0;
  console.error(`[worker] gateway HTTP ${status}, trying legacy fallback`);
  if (!isLegacyFallbackEnabled(env)) return errorJson("gateway error", 502);
  const legacy = legacyOrigin(env);
  if (!legacy) return errorJson("gateway error", 502);
  return Response.redirect(`${legacy}/api/tg-stream?mid=${mid}`, 302);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feed") return handleFeed(env, request);
    if (url.pathname === "/api/play") return handlePlay(env, request, url, ctx);
    if (url.pathname.startsWith("/m/")) {
      const parts = url.pathname.slice(3).split("/").filter(Boolean);
      if (parts.length !== 2) return errorJson("invalid path", 400);
      return handleMediaProxy(env, request, parts[0], parts[1], url);
    }
    if (url.pathname === "/api/tg-stream" || url.pathname === "/api/tg-thumb") {
      return handleLegacyTgApi(env, request, url);
    }
    if (url.pathname === "/api/health") return jsonResponse({ ok: true });

    // Static frontend fallback.
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return errorJson("static assets binding missing", 500);
    }
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error(`[worker] assets fetch failed: ${e && e.message}`);
      return errorJson("assets error", 502);
    }
  },
};
