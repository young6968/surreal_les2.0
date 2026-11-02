// Local, no-paid-call test: starts a fake "fal" server, runs the Worker against it
// (wrangler dev --local, FAL_BASE pointed at the fake), and checks every gate.
//   node test/local-test.mjs <path-to-wrangler.cmd>
import http from "node:http";
import { spawn } from "node:child_process";

const TOKEN = "test-token-123456";
const WORKER = "http://127.0.0.1:8801";
let fakeCalls = [];

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    fakeCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
    res.setHeader("Content-Type", "application/json");
    if (JSON.parse(body).prompt.includes("FAIL")) { res.statusCode = 422; res.end(JSON.stringify({ detail: "bad input from fake" })); return; }
    res.end(JSON.stringify({ images: [{ url: "data:image/jpeg;base64,AAAA", width: 1024, height: 768, content_type: "image/jpeg" }], seed: 42, has_nsfw_concepts: [false] }));
  });
}).listen(8899);

const wrangler = spawn(process.argv[2], ["dev", "--local", "--port", "8801", "--var", "FAL_BASE:http://127.0.0.1:8899", "--var", "MAX_REQUESTS_PER_MINUTE:100", "--var", "MAX_REQUESTS_PER_DAY:6"], { cwd: process.cwd(), shell: true });
let log = "";
wrangler.stdout.on("data", d => (log += d));
wrangler.stderr.on("data", d => (log += d));

const results = [];
const check = (name, ok, extra) => { results.push(ok); console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  -> " + JSON.stringify(extra))); };
const post = (body, headers = {}) => fetch(WORKER + "/v1/dream", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN, Origin: "https://young6968.github.io", ...headers }, body: JSON.stringify(body) });
const good = { image: "data:image/jpeg;base64,/9j/AAAA", prompt: "a dream of open borders, things distinct", width: 1000, height: 700 };

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(WORKER + "/v1/health"); if (r.status) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("worker did not start\n" + log.slice(-1500));
}

try {
  await waitUp();
  let r = await fetch(WORKER + "/v1/health"); check("health without token -> 401", r.status === 401, r.status);
  r = await fetch(WORKER + "/v1/health", { headers: { Authorization: "Bearer " + TOKEN, Origin: "https://young6968.github.io" } });
  let h = await r.json();
  check("health with token -> 200, key/lora/kv configured", r.status === 200 && h.falKeyConfigured && h.loraConfigured && h.kv.ok, h);
  check("health sends CORS header for the GitHub origin", r.headers.get("access-control-allow-origin") === "https://young6968.github.io", r.headers.get("access-control-allow-origin"));
  check("health made no fal call", fakeCalls.length === 0, fakeCalls.length);

  r = await fetch(WORKER + "/v1/dream", { method: "OPTIONS", headers: { Origin: "https://young6968.github.io" } });
  check("preflight -> 204", r.status === 204, r.status);
  r = await fetch(WORKER + "/v1/dream", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  check("preflight from unknown origin gets no allow header", !r.headers.get("access-control-allow-origin"), r.headers.get("access-control-allow-origin"));

  r = await post(good, { Authorization: "Bearer wrong" }); check("wrong token -> 401", r.status === 401, r.status);
  check("no fal call on 401", fakeCalls.length === 0, fakeCalls.length);
  r = await post({ ...good, image: "http://x/y.jpg" }); check("non data-URI image -> 400", r.status === 400, r.status);
  r = await post({ ...good, prompt: "short" }); check("tiny prompt -> 400", r.status === 400, r.status);
  check("no fal call on 400s", fakeCalls.length === 0, fakeCalls.length);

  r = await post({ ...good, strength: 5, scale: 99, model: "evil", loras: [{ path: "https://evil/x.safetensors", scale: 9 }] });
  let d = await r.json();
  check("good request -> 200 with image", r.status === 200 && d.image && d.seed === 42, { s: r.status, d });
  const sent = fakeCalls[0] && fakeCalls[0].body;
  check("fal got the Key auth header", fakeCalls[0] && fakeCalls[0].auth === "Key dummy-fal-key", fakeCalls[0] && fakeCalls[0].auth);
  check("fal path is the fixed image-to-image endpoint", fakeCalls[0] && fakeCalls[0].url === "/fal-ai/flux-lora/image-to-image", fakeCalls[0] && fakeCalls[0].url);
  check("strength clamped to 1, scale clamped to 1.5", sent && sent.strength === 1 && sent.loras[0].scale === 1.5, sent && [sent.strength, sent.loras[0].scale]);
  check("LoRA is the server's, not the client's", sent && sent.loras.length === 1 && sent.loras[0].path.startsWith("https://v3b.fal.media/"), sent && sent.loras);
  check("size rounded to multiples of 16", sent && sent.image_size.width === 1008 && sent.image_size.height === 704, sent && sent.image_size);
  check("one image, safety checker on, sync mode", sent && sent.num_images === 1 && sent.enable_safety_checker === true && sent.sync_mode === true, sent);

  r = await post({ ...good }); d = await r.json();
  check("defaults: strength 0.9, scale 1", fakeCalls[1] && fakeCalls[1].body.strength === 0.9 && fakeCalls[1].body.loras[0].scale === 1, fakeCalls[1] && [fakeCalls[1].body.strength, fakeCalls[1].body.loras[0].scale]);

  r = await post({ ...good, prompt: "FAIL this one please" }); d = await r.json();
  check("upstream 422 is passed along as an error", r.status === 422 && d.error === "upstream_error", { s: r.status, d });

  // 3 calls used so far today (2 ok + 1 failed); limit is 6
  for (let i = 0; i < 3; i++) await post(good);
  r = await post(good); d = await r.json();
  check("daily quota stops the 7th call", r.status === 429 && d.error === "daily_quota_reached", { s: r.status, d });
  const before = fakeCalls.length;
  await post(good);
  check("no fal call once the quota is hit", fakeCalls.length === before, [fakeCalls.length, before]);
} catch (e) {
  console.log("ERROR", e.message);
  results.push(false);
} finally {
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  spawn("taskkill", ["/pid", String(wrangler.pid), "/T", "/F"], { shell: true });
  fake.close();
  setTimeout(() => process.exit(pass === results.length ? 0 : 1), 800);
}
