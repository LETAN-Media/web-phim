// Cloudflare Worker: static frontend + R2 private video streaming.
// Standards: guard clauses / early return, no nested if/else, full error handling.
// No secrets hardcoded. R2 via native binding. Legacy VPS fallback is configurable.
const FEED_KEY = "meta/feed.json";
const MEDIA_PREFIX = "media/";
const API_VIDEO_PREFIX = "api/video/";

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

function getBucket(env) {
  const b = env.R2_BUCKET;
  if (!b || typeof b.get !== "function") return null;
  return b;
}

// Parse "bytes=start-end" -> { start, end } or null if invalid/missing.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === "" && e === "") return null;
  let start = 0;
  let end = size - 1;
  if (s === "") {
    const suffix = Number(e);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    return { start, end };
  }
  start = Number(s);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  if (e !== "") {
    end = Number(e);
    if (!Number.isFinite(end) || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function contentTypeFor(key, stored) {
  if (stored) return stored;
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".webm")) return "video/webm";
  if (key.endsWith(".mkv")) return "video/x-matroska";
  if (key.endsWith(".mov")) return "video/quicktime";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function serveR2Object(env, key, request) {
  const bucket = getBucket(env);
  if (!bucket) return errorJson("R2 binding missing", 500);
  if (!key || key.includes("..") || key.startsWith("/")) return errorJson("invalid key", 400);

  const headOnly = request.method === "HEAD";
  if (request.method !== "GET" && !headOnly) return errorJson("method not allowed", 405);

  let obj;
  try {
    obj = await bucket.head(key);
  } catch (e) {
    console.error(`[worker] R2 head failed key=${key}: ${e && e.message}`);
    return errorJson("R2 error", 502);
  }
  if (!obj) {
    const fb = await tryLegacyFallback(env, request, key);
    if (fb) return fb;
    return errorJson("object not found", 404);
  }

  const size = obj.size;
  if (!Number.isFinite(size) || size <= 0) return errorJson("invalid object size", 502);

  const ctype = contentTypeFor(key, obj.httpMetadata && obj.httpMetadata.contentType);
  const etag = obj.etag || undefined;
  const lastMod = obj.uploaded ? new Date(obj.uploaded).toUTCString() : undefined;

  const baseHeaders = {
    "content-type": ctype,
    "accept-ranges": "bytes",
    "cache-control": key.startsWith("videos/") ? "public, max-age=31536000, immutable" : "public, max-age=86400",
  };
  if (etag) baseHeaders["etag"] = etag;
  if (lastMod) baseHeaders["last-modified"] = lastMod;

  // Conditional request: ETag match -> 304.
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && etag && ifNoneMatch === etag && !headOnly) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) {
    if (headOnly) {
      return new Response(null, {
        status: 200,
        headers: { ...baseHeaders, "content-length": String(size) },
      });
    }
    let full;
    try {
      full = await bucket.get(key);
    } catch (e) {
      console.error(`[worker] R2 get failed key=${key}: ${e && e.message}`);
      return errorJson("R2 error", 502);
    }
    if (!full) return errorJson("object not found", 404);
    return new Response(full.body, {
      status: 200,
      headers: { ...baseHeaders, "content-length": String(size) },
    });
  }

  const parsed = parseRange(rangeHeader, size);
  if (!parsed) {
    return new Response("Requested Range Not Satisfiable", {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${size}` },
    });
  }

  const { start, end } = parsed;
  const length = end - start + 1;
  if (headOnly) {
    return new Response(null, {
      status: 206,
      headers: {
        ...baseHeaders,
        "content-length": String(length),
        "content-range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  let ranged;
  try {
    ranged = await bucket.get(key, { range: { offset: start, length } });
  } catch (e) {
    console.error(`[worker] R2 ranged get failed key=${key}: ${e && e.message}`);
    return errorJson("R2 error", 502);
  }
  if (!ranged) return errorJson("object not found", 404);
  return new Response(ranged.body, {
    status: 206,
    headers: {
      ...baseHeaders,
      "content-length": String(length),
      "content-range": `bytes ${start}-${end}/${size}`,
    },
  });
}

async function tryLegacyFallback(env, request, key) {
  if (!isLegacyFallbackEnabled(env)) return null;
  const origin = legacyOrigin(env);
  if (!origin) return null;
  const url = `${origin}/media/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  console.log(`[worker] R2 miss key=${key}, fallback to legacy ${url}`);
  try {
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range) headers.set("range", range);
    const r = await fetch(url, { method: request.method, headers, redirect: "follow" });
    return r;
  } catch (e) {
    console.error(`[worker] legacy fallback failed: ${e && e.message}`);
    return null;
  }
}

async function handleFeed(env, request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorJson("method not allowed", 405);
  }
  const bucket = getBucket(env);
  if (!bucket) return errorJson("R2 binding missing", 500);

  let feedObj = null;
  try {
    feedObj = await bucket.get(FEED_KEY);
  } catch (e) {
    console.error(`[worker] feed get failed: ${e && e.message}`);
    return errorJson("R2 error", 502);
  }

  if (!feedObj) {
    if (isLegacyFallbackEnabled(env)) {
      const origin = legacyOrigin(env);
      if (!origin) return jsonResponse({ ok: true, configured: false, count: 0, items: [] });
      try {
        const r = await fetch(`${origin}/api/feed`, { redirect: "follow" });
        if (!r.ok) return errorJson(`legacy feed HTTP ${r.status}`, 502);
        const data = await r.json();
        return jsonResponse(data);
      } catch (e) {
        console.error(`[worker] legacy feed failed: ${e && e.message}`);
        return errorJson("legacy feed error", 502);
      }
    }
    return jsonResponse({ ok: true, configured: true, count: 0, items: [] });
  }

  try {
    const data = await feedObj.json();
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    if (isNewGatewayEnabled(env)) {
      const chat = channelChatId(env);
      if (chat && data && Array.isArray(data.items)) {
        data.items = data.items.map((x) => ({
          ...x,
          chat_id: chat,
          message_id: x.mid,
          stream: `/api/play?mid=${x.mid}`,
        }));
      }
    }
    return jsonResponse(data);
  } catch (e) {
    console.error(`[worker] feed parse failed: ${e && e.message}`);
    return errorJson("invalid feed", 502);
  }
}

// Compatibility: /api/tg-stream?mid= / /api/tg-thumb?mid= -> resolve via feed to R2 key.
async function handleLegacyTgApi(env, request, url) {
  const mid = url.searchParams.get("mid");
  if (!mid) return errorJson("missing mid", 400);
  const isThumb = url.pathname === "/api/tg-thumb";

  const bucket = getBucket(env);
  if (!bucket) return errorJson("R2 binding missing", 500);

  let feedObj = null;
  try {
    feedObj = await bucket.get(FEED_KEY);
  } catch (e) {
    return errorJson("R2 error", 502);
  }
  if (!feedObj) {
    if (!isLegacyFallbackEnabled(env)) return errorJson("not migrated yet", 404);
    const origin = legacyOrigin(env);
    if (!origin) return errorJson("legacy not configured", 502);
    try {
      return await fetch(`${origin}${url.pathname}${url.search}`, { redirect: "follow" });
    } catch (e) {
      return errorJson("legacy error", 502);
    }
  }

  let feed;
  try {
    feed = await feedObj.json();
  } catch (e) {
    return errorJson("invalid feed", 502);
  }
  const items = (feed && feed.items) || [];
  const item = items.find((x) => String(x.mid) === String(mid));
  if (!item) return errorJson("not found", 404);

  const key = isThumb ? item.thumb_key || item.poster_key || null : item.r2_key || null;
  if (!key) {
    if (!isLegacyFallbackEnabled(env)) return errorJson("not migrated yet", 404);
    const origin = legacyOrigin(env);
    if (!origin) return errorJson("legacy not configured", 502);
    try {
      return await fetch(`${origin}${url.pathname}${url.search}`, { redirect: "follow" });
    } catch (e) {
      return errorJson("legacy error", 502);
    }
  }
  return serveR2Object(env, key, request);
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

async function getFeedItems(env) {
  const bucket = getBucket(env);
  if (!bucket) return null;
  let feedObj = null;
  try {
    feedObj = await bucket.get(FEED_KEY);
  } catch (e) {
    console.error(`[worker] feed get failed: ${e && e.message}`);
    return null;
  }
  if (!feedObj) return [];
  try {
    const data = await feedObj.json();
    return (data && data.items) || [];
  } catch (e) {
    console.error(`[worker] feed parse failed: ${e && e.message}`);
    return null;
  }
}

// GET /api/play?mid=<n>[&format=json] — fresh signed URL at play time, 302 by default.
async function handlePlay(env, request, url) {
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
  const items = await getFeedItems(env);
  if (items === null) return errorJson("feed error", 502);
  const found = items.some((x) => String(x.mid) === String(mid));
  if (!found) return errorJson("not found", 404);
  const signed = await signMediaUrl(env, chat, mid);
  if (!signed) return errorJson("signing not configured", 500);
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

  const upstream = `${origin}/v1/video/${chat}/${mid}?exp=${encodeURIComponent(
    url.searchParams.get("exp") || ""
  )}&sig=${encodeURIComponent(url.searchParams.get("sig") || "")}`;
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const inm = request.headers.get("if-none-match");
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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feed") return handleFeed(env, request);
    if (url.pathname === "/api/play") return handlePlay(env, request, url);
    if (url.pathname.startsWith("/m/")) {
      const parts = url.pathname.slice(3).split("/").filter(Boolean);
      if (parts.length !== 2) return errorJson("invalid path", 400);
      return handleMediaProxy(env, request, parts[0], parts[1], url);
    }
    if (url.pathname === "/api/tg-stream" || url.pathname === "/api/tg-thumb") {
      return handleLegacyTgApi(env, request, url);
    }
    if (url.pathname.startsWith(`/${MEDIA_PREFIX}`)) {
      const key = decodeURIComponent(url.pathname.slice(MEDIA_PREFIX.length + 1));
      return serveR2Object(env, key, request);
    }
    if (url.pathname.startsWith(`/${API_VIDEO_PREFIX}`)) {
      const key = decodeURIComponent(url.pathname.slice(API_VIDEO_PREFIX.length + 1));
      return serveR2Object(env, key, request);
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
