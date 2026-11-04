import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const dirOf = (specifier) => path.dirname(require.resolve(specifier));

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const password = process.env.FIREMON_ACCESS_PASSWORD || "";
const publicBind = !isLoopback(host);
const suppliedSessionSecret = process.env.FIREMON_SESSION_SECRET || "";
const trustProxy = process.env.TRUST_PROXY || "";
const authEnabled = Boolean(password);
const sessionSecret = suppliedSessionSecret || (authEnabled ? crypto.randomBytes(32).toString("hex") : "");
const production = process.env.NODE_ENV === "production";

function isLoopback(value) {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" ||
    (net.isIPv4(normalized) && normalized.startsWith("127."));
}

if (password && password.length < 12) {
  throw new Error("FIREMON_ACCESS_PASSWORD must be at least 12 characters.");
}
if (suppliedSessionSecret && Buffer.byteLength(suppliedSessionSecret) < 32) {
  throw new Error("FIREMON_SESSION_SECRET must be at least 32 bytes.");
}
if (publicBind && (!password || !suppliedSessionSecret)) {
  throw new Error("Public binding requires FIREMON_ACCESS_PASSWORD (12+ characters) and FIREMON_SESSION_SECRET (32+ bytes).");
}
if (publicBind && !trustProxy) {
  throw new Error("Public binding requires TRUST_PROXY for the trusted HTTPS reverse proxy in front of this server.");
}

const app = express();
app.disable("x-powered-by");
if (trustProxy) app.set("trust proxy", trustProxy);

app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (publicBind && !_isSecureRequest(_req)) {
    res.status(426).type("text/plain").send("HTTPS is required. Connect through the configured TLS reverse proxy.");
    return;
  }
  next();
});

const loginPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Firemon · Sign in</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#030407;color:#f4f2f0;font:15px system-ui,sans-serif}.card{width:min(390px,calc(100% - 32px));padding:30px;border:1px solid #ffffff18;border-radius:18px;background:#111219;box-shadow:0 20px 70px #0009}h1{margin:0 0 8px;font-size:25px;letter-spacing:-.04em}p{margin:0 0 24px;color:#a5a5af;font-size:13px}label{display:block;margin-bottom:7px;color:#c6c4ca;font-size:12px}input{width:100%;height:44px;padding:0 12px;border:1px solid #3b3c46;border-radius:9px;background:#090a0f;color:#fff;font:14px system-ui,sans-serif}button{width:100%;height:42px;margin-top:13px;border:0;border-radius:9px;background:#f07854;color:#21130f;font-weight:700;cursor:pointer}#error{min-height:20px;margin-top:12px;color:#ff937d;font-size:12px}.mark{color:#ff8564}</style></head>
<body><form class="card" id="login"><h1><span class="mark">🔥 Firemon</span> Unblocked</h1><p>This proxy is restricted. Enter the access password to continue.</p><label for="password">Access password</label><input id="password" type="password" autocomplete="current-password" required autofocus><button>Continue</button><div id="error" role="status" aria-live="polite"></div></form>
<script>document.querySelector("#login").addEventListener("submit",async e=>{e.preventDefault();const error=document.querySelector("#error");error.textContent="";try{const r=await fetch("/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.querySelector("#password").value})});if(!r.ok)throw new Error(r.status===429?"Too many attempts. Try again later.":"Password not accepted.");location.replace("/")}catch(x){error.textContent=x.message}})</script></body></html>`;

function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(left).digest();
  const b = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(a, b) && Buffer.byteLength(left) === Buffer.byteLength(right);
}

function signExpiry(expiry) {
  return crypto.createHmac("sha256", sessionSecret).update(expiry).digest("base64url");
}

function cookieValue(req, name) {
  const cookies = req.headers.cookie || "";
  for (const part of cookies.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

function hasValidSession(req) {
  if (!authEnabled) return true;
  const value = cookieValue(req, "firemon_session");
  const [expiry, signature, extra] = value.split(".");
  if (!expiry || !signature || extra || !/^\d+$/.test(expiry) || Number(expiry) <= Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signature, signExpiry(expiry));
}

function setSessionCookie(res) {
  const expiry = String(Math.floor(Date.now() / 1000) + 12 * 60 * 60);
  const signature = signExpiry(expiry);
  const secure = publicBind || production ? "; Secure" : "";
  res.setHeader("Set-Cookie", `firemon_session=${expiry}.${signature}; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict${secure}`);
}

const attempts = new Map();
function loginThrottle(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.until <= now) {
    attempts.delete(ip);
    return { blocked: false };
  }
  return { blocked: entry.count >= 5, retryAfter: Math.ceil((entry.until - now) / 1000) };
}
function recordFailure(ip) {
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || entry.until <= now) entry = { count: 0, until: now + 15 * 60 * 1000 };
  entry.count++;
  attempts.set(ip, entry);
  if (attempts.size > 5000) {
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    while (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
  }
}
function _isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  if (!trustProxy) return false;
  return String(req.get?.("x-forwarded-proto") || req.headers["x-forwarded-proto"] || "")
    .split(",")[0].trim().toLowerCase() === "https";
}

app.get("/login", (_req, res) => {
  if (!authEnabled) return res.redirect("/");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(loginPage);
});

app.post("/auth/login", express.json({ limit: "2kb" }), (req, res) => {
  if (!authEnabled) return res.status(404).end();
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Invalid origin." });
    } catch {
      return res.status(403).json({ error: "Invalid origin." });
    }
  }
  const throttle = loginThrottle(req.ip);
  if (throttle.blocked) {
    res.setHeader("Retry-After", String(throttle.retryAfter));
    return res.status(429).json({ error: "Too many attempts." });
  }
  const candidate = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(candidate, password)) {
    recordFailure(req.ip);
    return res.status(401).json({ error: "Authentication failed." });
  }
  attempts.delete(req.ip);
  setSessionCookie(res);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!authEnabled || req.path === "/auth/login" || hasValidSession(req)) return next();
  if (req.path === "/") return res.redirect(302, "/login");
  res.setHeader("Cache-Control", "no-store");
  return res.status(401).type("text/plain").send("Authentication required.");
});

app.use((req, res, next) => {
  if (/(^|\/)\.env(?:\.|\/|$)/i.test(req.path)) return res.status(404).end();
  next();
});

app.use("/scram/", express.static(scramjetPath, { fallthrough: false, dotfiles: "ignore" }));
app.use("/utils/", express.static(dirOf("@mercuryworkshop/scramjet-utils"), { fallthrough: false, dotfiles: "ignore" }));
app.use("/controller/", express.static(dirOf("@mercuryworkshop/scramjet-controller"), { fallthrough: false, dotfiles: "ignore" }));
app.use("/libcurl/", express.static(dirOf("@mercuryworkshop/libcurl-transport"), { fallthrough: false, dotfiles: "ignore" }));
app.use(express.static(publicDir, { dotfiles: "ignore" }));

app.use((_req, res) => res.status(404).type("text/plain").send("Not found."));

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const origin = req.headers.origin;
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin) && new URL(origin).host === req.headers.host; } catch {}
  if (pathname !== "/wisp/" || !sameOrigin || (publicBind && !_isSecureRequest(req)) || !hasValidSession(req)) {
    socket.destroy();
    return;
  }
  req.url = pathname;
  wisp.routeRequest(req, socket, head);
});

server.on("error", (error) => {
  console.error("Firemon failed to start:", error.message);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Firemon Unblocked listening on ${host}:${port}`);
  if (authEnabled) console.log("Server-side password protection is enabled.");
  if (publicBind) console.log("Public binding is protected by password authentication and a trusted HTTPS proxy.");
});
