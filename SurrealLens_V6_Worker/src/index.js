/*
  SurrealLens V6 -- fal proxy Worker.

  Holds the real fal key (env.FAL_KEY, a Worker secret) so the phone never
  does. The app sends a separate shared secret (APP_ACCESS_TOKEN) as
  "Authorization: Bearer <token>". Leaking that token only lets someone use
  THIS proxy up to its own per-minute / per-day limits; it never exposes the
  fal key.

  Routes:
    GET  /v1/health -- connectivity + token check. NEVER calls fal.
    POST /v1/dream  -- the only route that can reach fal. Draws ONE image:
                       FLUX + the fixed LoRA (env.LORA_URL), image-to-image.

  What the browser may choose: the photo, the prompt, the output size, and
  (clamped) strength / lora scale. What it may NOT choose: the model, the
  LoRA, the safety checker, the number of images. Those are fixed here.

  /v1/dream passes, in order: path/method -> per-IP minute limit -> body size
  -> Authorization -> schema validation -> per-token minute limit -> per-token
  daily quota. Only then is fal called. The daily counter is bumped BEFORE the
  call and is not refunded if fal fails (same behaviour as the Gemini proxy).

  KNOWN LIMITATIONS: the KV counters are read-then-write (soft limiter, not a
  race-free hard cap). APP_ACCESS_TOKEN sits in the browser's localStorage, so
  it is only an interim guard for a single-person research tool.
*/

var FAL_PATH = "fal-ai/flux-lora/image-to-image";
var MAX_BODY_BYTES = 8 * 1024 * 1024;
var MAX_PER_MINUTE_IP = 20;
var MIN_SIDE = 512;
var MAX_SIDE = 1536;

function corsHeaders(origin, allowedOrigins) {
  var headers = { "Vary": "Origin" };
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  }
  return headers;
}

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {})
  });
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  var mismatch = 0;
  for (var i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function getCounter(kv, key) {
  var raw = await kv.get(key);
  return raw ? (parseInt(raw, 10) || 0) : 0;
}
async function incrCounter(kv, key, ttlSeconds) {
  var current = await getCounter(kv, key);
  await kv.put(key, String(current + 1), { expirationTtl: ttlSeconds });
  return current + 1;
}
function minuteBucketKey(prefix, id) {
  return "fal:rl:" + prefix + ":" + id + ":" + Math.floor(Date.now() / 60000);
}
function dayBucketKey(prefix, id) {
  return "fal:usage:" + prefix + ":" + id + ":" + new Date().toISOString().slice(0, 10);
}

function num(value, fallback, lo, hi) {
  var n = typeof value === "number" ? value : parseFloat(value);
  if (!isFinite(n)) n = fallback;
  return Math.min(hi, Math.max(lo, n));
}
function side(value) {
  var n = Math.round(num(value, 1024, MIN_SIDE, MAX_SIDE) / 16) * 16;
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, n));
}
function loraOk(url) {
  return typeof url === "string" && url.indexOf("https://") === 0 && /\.safetensors$/.test(url.split("?")[0]);
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var origin = request.headers.get("Origin") || "";
    var allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var cors = corsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== "/v1/dream" && url.pathname !== "/v1/health") return json(404, { error: "not_found" }, cors);
    if (url.pathname === "/v1/health" && request.method !== "GET") return json(405, { error: "method_not_allowed" }, cors);
    if (url.pathname === "/v1/dream" && request.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);

    var ip = request.headers.get("CF-Connecting-IP") || "unknown-ip";
    var ipCount = await incrCounter(env.USAGE_KV, minuteBucketKey("ip", ip), 70);
    if (ipCount > MAX_PER_MINUTE_IP) return json(429, { error: "rate_limited", scope: "ip" }, cors);

    var maxPerMinute = parseInt(env.MAX_REQUESTS_PER_MINUTE, 10);
    if (isNaN(maxPerMinute)) maxPerMinute = 5;
    var maxPerDay = parseInt(env.MAX_REQUESTS_PER_DAY, 10);
    if (isNaN(maxPerDay)) maxPerDay = 30;

    var authHeader = request.headers.get("Authorization") || "";
    var token = authHeader.indexOf("Bearer ") === 0 ? authHeader.slice(7) : "";

    if (url.pathname === "/v1/health") {
      if (!env.APP_ACCESS_TOKEN || !safeCompare(token, env.APP_ACCESS_TOKEN)) return json(401, { error: "unauthorized" }, cors);
      var kvStatus = { ok: true, error: null };
      try {
        await env.USAGE_KV.put("fal:health:probe", String(Date.now()), { expirationTtl: 60 });
        if ((await env.USAGE_KV.get("fal:health:probe")) == null) kvStatus = { ok: false, error: "put succeeded but get returned null" };
      } catch (err) {
        kvStatus = { ok: false, error: (err && err.message) || String(err) };
      }
      var used = await getCounter(env.USAGE_KV, dayBucketKey("token", token.slice(0, 12)));
      return json(200, {
        ok: true,
        workerOk: true,
        falKeyConfigured: !!env.FAL_KEY,
        appTokenConfigured: !!env.APP_ACCESS_TOKEN,
        loraConfigured: loraOk(env.LORA_URL),
        kv: kvStatus,
        defaults: { strength: num(env.STRENGTH, 0.9, 0.3, 1), loraScale: num(env.LORA_SCALE, 1, 0, 1.5) },
        limits: { maxRequestsPerMinute: maxPerMinute, maxRequestsPerDay: maxPerDay },
        quotaToday: { used: used, limit: maxPerDay },
        note: "This only confirms the Worker and your Access Token. It does NOT confirm the fal key is valid or that fal is reachable -- this endpoint never calls fal."
      }, cors);
    }

    var contentLength = request.headers.get("Content-Length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" }, cors);
    var rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" }, cors);

    if (!env.APP_ACCESS_TOKEN || !safeCompare(token, env.APP_ACCESS_TOKEN)) return json(401, { error: "unauthorized" }, cors);

    var body;
    try { body = JSON.parse(rawBody); } catch (e) { return json(400, { error: "invalid_json" }, cors); }
    var image = body && body.image;
    var prompt = body && body.prompt;
    if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image.slice(0, 40))) {
      return json(400, { error: "invalid_image" }, cors);
    }
    if (typeof prompt !== "string" || prompt.length < 10 || prompt.length > 3000) {
      return json(400, { error: "invalid_prompt" }, cors);
    }
    if (!env.FAL_KEY) return json(500, { error: "fal_key_not_configured" }, cors);
    if (!loraOk(env.LORA_URL)) return json(500, { error: "lora_not_configured" }, cors);

    var tokenMinuteCount = await incrCounter(env.USAGE_KV, minuteBucketKey("token", token.slice(0, 12)), 70);
    if (tokenMinuteCount > maxPerMinute) return json(429, { error: "rate_limited", scope: "per_minute" }, cors);

    var dayKey = dayBucketKey("token", token.slice(0, 12));
    if ((await getCounter(env.USAGE_KV, dayKey)) >= maxPerDay) {
      return json(429, { error: "daily_quota_reached", note: "Self-imposed cap (MAX_REQUESTS_PER_DAY) enforced by this Worker." }, cors);
    }
    await incrCounter(env.USAGE_KV, dayKey, 90000);

    var strength = num(body.strength, num(env.STRENGTH, 0.9, 0.3, 1), 0.3, 1);
    var scale = num(body.scale, num(env.LORA_SCALE, 1, 0, 1.5), 0, 1.5);
    var falBody = {
      prompt: prompt,
      image_url: image,
      strength: strength,
      loras: [{ path: env.LORA_URL, scale: scale }],
      image_size: { width: side(body.width), height: side(body.height) },
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      enable_safety_checker: true,
      output_format: "jpeg",
      sync_mode: true
    };

    var base = (env.FAL_BASE || "https://fal.run").replace(/\/+$/, "");
    var res;
    try {
      res = await fetch(base + "/" + FAL_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Key " + env.FAL_KEY },
        body: JSON.stringify(falBody)
      });
    } catch (err) {
      return json(502, { error: "upstream_fetch_failed" }, cors);
    }
    var text = await res.text();
    if (!res.ok) {
      /* Pass fal's own message along (never our key); trimmed so a huge page can't leak through. */
      return json(res.status === 401 || res.status === 403 ? 502 : res.status, {
        error: "upstream_error", upstreamStatus: res.status, detail: text.slice(0, 300)
      }, cors);
    }
    var data;
    try { data = JSON.parse(text); } catch (e) { return json(502, { error: "upstream_bad_json" }, cors); }
    var img = data && data.images && data.images[0];
    if (!img || !img.url) return json(502, { error: "upstream_no_image" }, cors);
    return json(200, {
      image: img.url,
      width: img.width || null,
      height: img.height || null,
      seed: data.seed == null ? null : data.seed,
      nsfw: !!(data.has_nsfw_concepts && data.has_nsfw_concepts[0]),
      strength: strength,
      scale: scale
    }, cors);
  }
};
