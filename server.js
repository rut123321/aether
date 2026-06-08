import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");

function generateApiKey() {
  return `sk-${randomBytes(32).toString("hex")}`;
}

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  // Prevent CSV injection (formula injection): leading =, +, -, @ or tab/CR
  // are reinterpreted as formulas by spreadsheet apps. Prefix with single quote.
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(str);
  const guarded = needsFormulaGuard ? `'${str}` : str;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

// Per-request CSP — only allow self, no remote scripts/styles, no inline.
// Inline event handlers and inline <style> blocks are still allowed
// because the bundled pages rely on them; locking down later would require
// extracting them.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data:; font-src 'self' data:; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self';";

const IS_PRODUCTION = process.env.NODE_ENV === "production" ||
  Boolean(process.env.RENDER) || Boolean(process.env.RENDER_EXTERNAL_URL);

// Session management — sessions live in memory and expire after SESSION_TTL_MS.
const SESSION_TTL_MS = readPositiveIntegerEnv("SESSION_TTL_MS", 24 * 60 * 60 * 1000);
const activeSessions = new Map();

function parseCookie(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = {};
  cookieHeader.split(";").forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    if (name && rest.length > 0) cookies[name] = rest.join("=");
  });
  return cookies;
}

function createSession() {
  const token = randomBytes(32).toString("hex");
  activeSessions.set(token, { createdAt: Date.now() });
  return token;
}

function validateSession(req) {
  const cookies = parseCookie(req);
  const token = cookies.aether_session;
  if (!token) return false;
  const entry = activeSessions.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

function clearSession(token) {
  activeSessions.delete(token);
}

// Periodically purge expired sessions so the Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of activeSessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      activeSessions.delete(token);
    }
  }
}, Math.min(SESSION_TTL_MS, 60 * 60 * 1000)).unref();

function buildSessionCookie(token, maxAgeSeconds) {
  const parts = [
    `aether_session=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Strict",
  ];
  if (IS_PRODUCTION) parts.push("Secure");
  return parts.join("; ");
}

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function generateRandomPassword(length = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let result = "";
  const bytes = randomBytes(length * 2);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || generateRandomPassword();
if (!process.env.ADMIN_PASSWORD) {
  console.log("=".repeat(60));
  console.log("WARNING: ADMIN_PASSWORD not set in environment.");
  console.log(`Generated random admin password: ${ADMIN_PASSWORD}`);
  console.log("Set ADMIN_PASSWORD env var for a persistent password.");
  console.log("=".repeat(60));
}
const MAX_REQUEST_BYTES = readPositiveIntegerEnv(
  "MAX_REQUEST_BYTES",
  20 * 1024 * 1024,
);
const AGENTROUTER_BASE_URL = stripTrailingSlash(
  process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org/v1",
);
const DEFAULT_AGENTROUTER_API_KEY = process.env.AGENTROUTER_API_KEY || "";
const PROXY_SHARED_KEY = process.env.PROXY_SHARED_KEY || "";
const AGENTROUTER_RELAY_KEY = process.env.AGENTROUTER_RELAY_KEY || "";
const UPSTREAM_WAF_RETRY = process.env.UPSTREAM_WAF_RETRY !== "false";
const UPSTREAM_USER_AGENT =
  process.env.UPSTREAM_USER_AGENT || "AetherEndpoint/1.0";
const NON_STREAM_KEEPALIVE = process.env.NON_STREAM_KEEPALIVE !== "false";
const NON_STREAM_KEEPALIVE_START_MS = readPositiveIntegerEnv(
  "NON_STREAM_KEEPALIVE_START_MS",
  60_000,
);
const NON_STREAM_KEEPALIVE_INTERVAL_MS = readPositiveIntegerEnv(
  "NON_STREAM_KEEPALIVE_INTERVAL_MS",
  15_000,
);
const ALLOW_DIRECT_UPSTREAM_KEYS = process.env.ALLOW_DIRECT_UPSTREAM_KEYS === "true";
const ALLOW_SERVER_KEY_PROXY = process.env.ALLOW_SERVER_KEY_PROXY === "true";
const ALLOWED_MODELS = ["claude-opus-4-7", "glm-5.1"];
const CREDITS_PER_TOKEN = readPositiveIntegerEnv("CREDITS_PER_TOKEN", 50);
const AGENTROUTER_CLIENT_PROFILE = process.env.AGENTROUTER_CLIENT_PROFILE || "none";
const CODEX_COMPAT_VERSION = process.env.AGENTROUTER_CODEX_VERSION || "0.101.0";
const CODEX_COMPAT_USER_AGENT =
  process.env.AGENTROUTER_CODEX_USER_AGENT ||
  `codex_cli_rs/${CODEX_COMPAT_VERSION} (Mac OS 26.0.1; arm64) Apple_Terminal/464`;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// Rate limiting store (in-memory; cleared on restart)
const rateLimitStore = new Map();

function checkRateLimit(identifier, maxAttempts = 10, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(identifier, { count: 1, resetAt: now + windowMs });
    return true;
  }

  entry.count++;
  if (entry.count > maxAttempts) {
    return false;
  }
  return true;
}

function getClientIdentifier(req) {
  const forwarded = getHeaderValue(req.headers, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const isAdminPath = isAdminApiPath(url.pathname) || url.pathname === "/api/admin/verify";
    addCorsHeaders(res, isAdminPath);
    addSecurityHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const clientIp = getClientIdentifier(req);

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/config") {
      sendJson(res, 200, {
        proxyBasePath: "/v1",
        docsUrl: "https://docs.agentrouter.org/",
        tokenUrl: "https://agentrouter.org/console/token",
      });
      return;
    }

    if (isAdminApiPath(url.pathname) && !isAuthorizedAdmin(req)) {
      sendJson(res, 401, {
        error: {
          message: "Missing or invalid admin token",
          hint: ADMIN_TOKEN
            ? "Send x-admin-token or Authorization: Bearer <ADMIN_TOKEN>."
            : "Set ADMIN_TOKEN in the deployed service environment.",
        },
      });
      return;
    }

    // Admin password verification
    if (url.pathname === "/api/admin/verify" && req.method === "POST") {
      if (!checkRateLimit(`login:${clientIp}`, 5, 60000)) {
        sendJson(res, 429, { error: { message: "Too many attempts. Try again in a minute." } });
        return;
      }
      const { password } = await readJsonBody(req);
      const supplied = String(password || "");
      if (ADMIN_PASSWORD && safeEqual(supplied, ADMIN_PASSWORD)) {
        const token = createSession();
        res.setHeader("Set-Cookie", buildSessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
        sendJson(res, 200, { success: true });
      } else {
        sendJson(res, 401, { error: { message: "Invalid password" } });
      }
      return;
    }

    // Logout
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const cookies = parseCookie(req);
      const token = cookies.aether_session;
      if (token) clearSession(token);
      res.setHeader("Set-Cookie", buildSessionCookie("", 0));
      sendJson(res, 200, { success: true });
      return;
    }

    // API Key management endpoints
    if (url.pathname === "/api/keys" && req.method === "GET") {
      const rows = await db.listKeys();
      const keysList = rows.map((row) => ({
        key: row.key.slice(0, 8) + "..." + row.key.slice(-4),
        name: row.name,
        credits: row.credits,
        createdAt: row.created_at,
      }));
      sendJson(res, 200, { keys: keysList });
      return;
    }

    if (url.pathname === "/api/keys/export.csv" && req.method === "GET") {
      const rows = await db.listKeys();
      const header = "name,key,credits,created_at\n";
      const body = rows
        .map((r) => [r.name, r.key, r.credits, r.created_at].map(csvEscape).join(","))
        .join("\n");
      const filename = `aether-keys-${new Date().toISOString().slice(0, 10)}.csv`;
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      });
      res.end(header + body + (body ? "\n" : ""));
      return;
    }

    if (url.pathname === "/api/keys/reveal" && req.method === "POST") {
      const { partialKey } = await readJsonBody(req);
      const normalizedPartial = String(partialKey || "").trim();
      if (!normalizedPartial.includes("...")) {
        sendJson(res, 400, { error: { message: "Invalid partial key format" } });
        return;
      }
      const [prefix, suffix] = normalizedPartial.split("...");
      // Only allow the same charset our generated keys use, so the strings
      // passed to PostgREST cannot include filter operators or wildcards.
      if (!/^sk-[a-zA-Z0-9]{1,16}$/.test(prefix) || !/^[a-zA-Z0-9]{1,16}$/.test(suffix)) {
        sendJson(res, 400, { error: { message: "Invalid partial key format" } });
        return;
      }
      const matched = await db.findKeyByPartial(prefix, suffix);
      if (matched) {
        sendJson(res, 200, { fullKey: matched.key, name: matched.name });
      } else {
        sendJson(res, 404, { error: { message: "Key not found" } });
      }
      return;
    }

    // Rate limit key mutations per IP
    if ((url.pathname === "/api/keys" || url.pathname.startsWith("/api/keys/")) && ["POST", "DELETE"].includes(req.method)) {
      if (!checkRateLimit(`keys:${clientIp}`, 20, 60000)) {
        sendJson(res, 429, { error: { message: "Too many requests. Try again later." } });
        return;
      }
    }

    if (url.pathname === "/api/keys" && req.method === "POST") {
      const { name, credits } = await readJsonBody(req);
      const normalizedName = String(name || "").trim();
      const normalizedCredits = Number(credits);

      if (!normalizedName || !Number.isFinite(normalizedCredits) || normalizedCredits < 1) {
        sendJson(res, 400, {
          error: {
            message: "Name and positive credits are required",
          },
        });
        return;
      }

      const newKey = generateApiKey();
      const inserted = await db.insertKey({
        key: newKey,
        name: normalizedName,
        credits: Math.floor(normalizedCredits),
      });
      sendJson(res, 201, {
        key: newKey,
        name: inserted.name,
        credits: inserted.credits,
      });
      return;
    }

    if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
      const keyToDelete = url.pathname.slice("/api/keys/".length);
      const deleted = await db.deleteKey(keyToDelete);
      if (deleted) {
        sendJson(res, 200, { message: "Key deleted" });
      } else {
        sendJson(res, 404, { error: "Key not found" });
      }
      return;
    }

    // Subtract credits from existing key (admin)
    if (url.pathname === "/api/keys/subtract" && req.method === "POST") {
      const { key, credits } = await readJsonBody(req);
      const targetKey = String(key || "").trim();
      const creditsToSubtract = Number(credits);

      if (!targetKey || !Number.isFinite(creditsToSubtract) || creditsToSubtract <= 0) {
        sendJson(res, 400, { error: "key and positive credits are required" });
        return;
      }

      const updated = await db.subtractCredits(targetKey, Math.floor(creditsToSubtract));
      if (!updated) {
        sendJson(res, 404, { error: "Key not found" });
        return;
      }

      sendJson(res, 200, {
        message: "Credits subtracted",
        key: targetKey,
        name: updated.name,
        credits: updated.credits,
      });
      return;
    }

    // Add credits to existing key
    if (url.pathname.startsWith("/api/keys/") && req.method === "POST") {
      const keyToAddCredits = url.pathname.slice("/api/keys/".length);
      const { credits } = await readJsonBody(req);
      const creditsToAdd = Number(credits);

      if (!Number.isFinite(creditsToAdd) || creditsToAdd <= 0) {
        sendJson(res, 400, { error: "Credits must be a positive number" });
        return;
      }

      const updated = await db.addCredits(keyToAddCredits, Math.floor(creditsToAdd));
      if (!updated) {
        sendJson(res, 404, { error: "Key not found" });
        return;
      }

      sendJson(res, 200, {
        message: "Credits added",
        key: keyToAddCredits,
        name: updated.name,
        credits: updated.credits,
      });
      return;
    }

    if (url.pathname === "/api/balance" && req.method === "POST") {
      if (!checkRateLimit(`balance:${clientIp}`, 30, 60000)) {
        sendJson(res, 429, { error: { message: "Too many requests. Try again later." } });
        return;
      }
      const { key } = await readJsonBody(req);
      const normalizedKey = String(key || "").trim();
      // Reject obviously malformed keys without hitting the DB.
      if (!normalizedKey || !/^sk-[a-zA-Z0-9_-]{8,128}$/.test(normalizedKey)) {
        sendJson(res, 404, { error: "Key not found" });
        return;
      }
      const row = await db.getKey(normalizedKey);
      if (row) {
        const history = await db.recentUsage(normalizedKey, 10);
        sendJson(res, 200, {
          balance: row.credits,
          name: row.name,
          history: (history || []).map((h) => ({
            model: h.model,
            tokens: h.tokens,
            credits: h.credits,
            createdAt: h.created_at,
          })),
        });
      } else {
        sendJson(res, 404, { error: "Key not found" });
      }
      return;
    }

    if (url.pathname === "/api/stats" && req.method === "GET") {
      const s = await db.stats();
      sendJson(res, 200, s);
      return;
    }

    if (isProxyPath(url.pathname)) {
      await proxyToAgentRouter(req, res, url);
      return;
    }

    if (url.pathname === "/balance") {
      const balanceHtml = await readFile(resolve(publicDir, "balance.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(balanceHtml);
      return;
    }

    if (url.pathname === "/faq") {
      const faqHtml = await readFile(resolve(publicDir, "faq.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(faqHtml);
      return;
    }

    // Protect admin panel assets — require server-side session.
    // styles.css is intentionally excluded so /balance and /faq render properly.
    const protectedPaths = ["/", "/index.html", "/app.js"];
    if (protectedPaths.includes(url.pathname) && !validateSession(req)) {
      if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
        sendJson(res, 403, { error: { message: "Forbidden" } });
      } else {
        res.writeHead(302, { "Location": "/login.html" });
        res.end();
      }
      return;
    }

    await serveStatic(url, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      const statusCode = Number(error.statusCode) || 500;
      sendJson(res, statusCode, {
        error: {
          message: statusCode >= 500 ? "Internal proxy error" : error.message,
          detail: statusCode >= 500 ? formatError(error) : undefined,
        },
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`AgentRouter endpoint UI: http://localhost:${PORT}`);
  console.log(`OpenAI-compatible proxy: http://localhost:${PORT}/v1`);
  console.log(`Forwarding to: ${AGENTROUTER_BASE_URL}`);
});

async function proxyToAgentRouter(req, res, incomingUrl) {
  if (PROXY_SHARED_KEY && !isValidProxyKey(req)) {
    sendJson(res, 401, {
      error: {
        message: "Missing or invalid proxy key",
        hint: "Send x-proxy-key with the value from PROXY_SHARED_KEY.",
      },
    });
    return;
  }

  // Check for custom API key
  const customApiKey = getBearerToken(req.headers);
  let usingCustomKey = false;
  let keyData = null;

  if (customApiKey) {
    keyData = await db.getKey(customApiKey);
    if (keyData) {
      usingCustomKey = true;

      if (keyData.credits <= 0) {
        sendJson(res, 402, {
          error: {
            message: "Insufficient credits",
            hint: "Your API key has no credits remaining.",
          },
        });
        return;
      }
    }
  }

  const directUpstreamKey = getDirectUpstreamKey(req.headers);

  if (!usingCustomKey && directUpstreamKey && !canUseDirectUpstreamKeys(req)) {
    sendJson(res, 401, {
      error: {
        message: "Direct upstream keys are disabled on public requests",
        hint: "Use a custom endpoint key, set PROXY_SHARED_KEY, or enable ALLOW_DIRECT_UPSTREAM_KEYS=true.",
      },
    });
    return;
  }

  if (
    !usingCustomKey &&
    !directUpstreamKey &&
    !(DEFAULT_AGENTROUTER_API_KEY && canUseServerApiKeyFallback(req))
  ) {
    sendJson(res, 401, {
      error: {
        message: "Missing endpoint key",
        hint: "Send a generated custom key in Authorization: Bearer <key>.",
      },
    });
    return;
  }

  if (usingCustomKey && !DEFAULT_AGENTROUTER_API_KEY) {
    sendJson(res, 500, {
      error: {
        message: "AGENTROUTER_API_KEY is required to use custom endpoint keys",
      },
    });
    return;
  }

  const upstreamUrl = buildUpstreamUrl(incomingUrl);
  let requestBody = canHaveBody(req.method) ? await readRequestBody(req) : undefined;

  // Parse body once (used for model validation, stream detection, and forcing include_usage)
  let parsedBody = null;
  if (requestBody && requestBody.length) {
    try {
      parsedBody = JSON.parse(requestBody.toString());
    } catch {}
  }

  // Validate model if present in request body
  if (parsedBody && parsedBody.model) {
    const requestedModel = String(parsedBody.model);
    if (!ALLOWED_MODELS.includes(requestedModel)) {
      sendJson(res, 400, {
        error: {
          message: `Model "${requestedModel}" is not allowed`,
          hint: `Allowed models: ${ALLOWED_MODELS.join(", ")}`,
          type: "invalid_request_error",
        },
      });
      return;
    }
  }

  // For streaming requests with a custom key, force the upstream to include usage
  // in the final SSE chunk so we deduct based on real tokens, not byte estimates.
  const isStream = Boolean(parsedBody && parsedBody.stream === true);
  if (usingCustomKey && isStream && parsedBody) {
    parsedBody.stream_options = {
      ...(parsedBody.stream_options || {}),
      include_usage: true,
    };
    requestBody = Buffer.from(JSON.stringify(parsedBody));
  }

  const jsonKeepAlive = shouldUseNonStreamKeepAlive(req, isStream, parsedBody)
    ? createDelayedJsonKeepAlive(res)
    : null;

  const upstreamResult = await fetchUpstreamWithWafRetry(
    req,
    upstreamUrl,
    usingCustomKey,
    requestBody,
  );

  if (upstreamResult.wafChallenge) {
    const payload = {
      error: {
        code: "UPSTREAM_WAF_CHALLENGE",
        message: "AgentRouter returned an Aliyun WAF browser verification page instead of an API response.",
        hint: "The request reached AgentRouter. Clean API headers and the compatibility retry were both challenged, so this is likely a Render/Railway egress IP block. Ask AgentRouter for allowlist/server-to-server access or use a different outbound IP.",
        upstreamStatus: upstreamResult.status,
        upstreamBaseUrl: AGENTROUTER_BASE_URL,
        attemptedProfiles: upstreamResult.attemptedProfiles,
      },
    };
    if (finishJsonKeepAlive(jsonKeepAlive, payload)) {
      return;
    }
    sendJson(res, 502, payload);
    return;
  }

  if (upstreamResult.htmlResponse) {
    if (finishJsonKeepAlive(jsonKeepAlive, {
      error: {
        message: "Upstream returned an HTML response instead of JSON.",
        upstreamStatus: upstreamResult.status,
      },
    })) {
      return;
    }
    res.writeHead(upstreamResult.status, {
      "content-type": upstreamResult.contentType || "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(upstreamResult.responseText);
    return;
  }

  const upstreamResponse = upstreamResult.response;

  if (jsonKeepAlive?.started) {
    const responseText = upstreamResponse.body ? await upstreamResponse.text() : "";
    if (usingCustomKey) {
      await deductCreditsFromResponseText(customApiKey, responseText, parsedBody?.model);
    }
    finishJsonKeepAliveRaw(jsonKeepAlive, responseText);
    return;
  }
  cancelJsonKeepAlive(jsonKeepAlive);

  const responseHeaders = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (!shouldSkipResponseHeader(key)) {
      responseHeaders[key] = value;
    }
  });

  responseHeaders["access-control-allow-origin"] = "*";
  responseHeaders["access-control-expose-headers"] = "*";

  res.writeHead(upstreamResponse.status, responseHeaders);

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  if (usingCustomKey) {
    if (isStream) {
      // Handle streaming response to deduct credits
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let totalTokens = 0;
      let streamModel = null;
      let buffer = "";

      const stream = new Readable({
        read() {}
      });

      reader.read().then(async function process({ done, value }) {
        if (done) {
          stream.push(null);
          // Only deduct what the upstream actually reported. If usage was
          // missing (some upstreams omit it), deduct a tiny minimum so we
          // never invent giant token counts from response byte length.
          const tokensToCharge = totalTokens > 0 ? totalTokens : 1;
          const creditsToDeduct = tokensToCharge * CREDITS_PER_TOKEN;
          try {
            await db.deductCredits(customApiKey, creditsToDeduct);
            await db.logUsage({
              key: customApiKey,
              model: parsedBody?.model || streamModel || null,
              tokens: tokensToCharge,
              credits: creditsToDeduct,
            });
          } catch (err) {
            console.error("deductCredits failed:", err.message);
          }
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        stream.push(chunk);

        // Accumulate across chunks — SSE events can be split mid-line.
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const tt = parsed.usage?.total_tokens;
            if (typeof tt === "number" && tt > totalTokens) {
              totalTokens = tt;
            }
            if (!streamModel && typeof parsed.model === "string") {
              streamModel = parsed.model;
            }
          } catch {}
        }

        reader.read().then(process);
      });

      stream.pipe(res);
    } else {
      // Handle non-streaming response
      const responseText = await upstreamResponse.text();
      await deductCreditsFromResponseText(customApiKey, responseText, parsedBody?.model);
      res.end(responseText);
    }
  } else {
    Readable.fromWeb(upstreamResponse.body).pipe(res);
  }
}

async function deductCreditsFromResponseText(customApiKey, responseText, model) {
  try {
    const responseData = JSON.parse(responseText);
    const totalTokens = Number(responseData.usage?.total_tokens) || 0;
    const tokensToCharge = totalTokens > 0 ? totalTokens : 1;
    const creditsToDeduct = tokensToCharge * CREDITS_PER_TOKEN;
    try {
      await db.deductCredits(customApiKey, creditsToDeduct);
      await db.logUsage({
        key: customApiKey,
        model: model || responseData.model || null,
        tokens: tokensToCharge,
        credits: creditsToDeduct,
      });
    } catch (err) {
      console.error("deductCredits failed:", err.message);
    }
  } catch {
    // Keep the upstream body unchanged even when it is not JSON.
  }
}

async function fetchUpstreamWithWafRetry(req, upstreamUrl, usingCustomKey, requestBody) {
  const attemptedProfiles = [];
  const profiles = buildUpstreamHeaderProfiles();

  for (const profile of profiles) {
    attemptedProfiles.push(profile);
    const headers = buildUpstreamHeaders(req, usingCustomKey, profile);
    const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: requestBody,
    redirect: "manual",
  });

    if (!isHtmlResponse(upstreamResponse)) {
      return { response: upstreamResponse, attemptedProfiles };
    }

    const responseText = await upstreamResponse.text();
    if (!isAliyunWafChallenge(responseText)) {
      return {
        htmlResponse: true,
        status: upstreamResponse.status,
        contentType: upstreamResponse.headers.get("content-type"),
        responseText,
        attemptedProfiles,
      };
    }

    if (!UPSTREAM_WAF_RETRY) {
      break;
    }
  }

  return {
    wafChallenge: true,
    status: 200,
    attemptedProfiles,
  };
}

function buildUpstreamUrl(incomingUrl) {
  const proxyPath = incomingUrl.pathname.startsWith("/api/proxy/v1")
    ? incomingUrl.pathname.replace(/^\/api\/proxy\/v1/, "")
    : incomingUrl.pathname.replace(/^\/v1/, "");

  const pathname = `${AGENTROUTER_BASE_URL}${proxyPath || ""}`;
  return `${pathname}${incomingUrl.search}`;
}

function buildUpstreamHeaderProfiles() {
  const profiles = [AGENTROUTER_CLIENT_PROFILE];

  if (UPSTREAM_WAF_RETRY && !profiles.includes("codex")) {
    profiles.push("codex");
  }

  return profiles;
}

function buildUpstreamHeaders(req, usingCustomKey = false, clientProfile = AGENTROUTER_CLIENT_PROFILE) {
  const incomingHeaders = req.headers;
  const headers = {};

  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lowerKey = key.toLowerCase();
    if (!shouldForwardRequestHeader(lowerKey)) {
      continue;
    }

    headers[lowerKey] = Array.isArray(value) ? value.join(", ") : value;
  }

  // Custom endpoint keys are backed by the server AgentRouter key.
  // Plain public proxy fallback is disabled unless explicitly allowed.
  if (usingCustomKey) {
    if (DEFAULT_AGENTROUTER_API_KEY) {
      headers.authorization = `Bearer ${DEFAULT_AGENTROUTER_API_KEY}`;
    }
  } else {
    const directUpstreamKey = canUseDirectUpstreamKeys(req)
      ? getDirectUpstreamKey(incomingHeaders)
      : "";

    if (directUpstreamKey) {
      headers.authorization = `Bearer ${directUpstreamKey}`;
    } else if (DEFAULT_AGENTROUTER_API_KEY && canUseServerApiKeyFallback(req)) {
      headers.authorization = `Bearer ${DEFAULT_AGENTROUTER_API_KEY}`;
    }
  }

  delete headers["x-agentrouter-key"];
  delete headers["x-agentrouter-api-key"];
  delete headers["x-proxy-key"];
  delete headers["x-relay-key"];

  if (AGENTROUTER_RELAY_KEY) {
    headers["x-relay-key"] = AGENTROUTER_RELAY_KEY;
  }

  applyApiHeaderProfile(headers);
  applyClientProfile(headers, clientProfile);

  return headers;
}

function applyApiHeaderProfile(headers) {
  headers.accept = "application/json, text/event-stream";
  headers["user-agent"] = UPSTREAM_USER_AGENT;
}

function applyClientProfile(headers, clientProfile = AGENTROUTER_CLIENT_PROFILE) {
  if (clientProfile === "none") {
    return;
  }

  if (clientProfile === "codex") {
    headers.originator = "codex_cli_rs";
    headers["user-agent"] = CODEX_COMPAT_USER_AGENT;
    headers.version = CODEX_COMPAT_VERSION;
  }
}

function shouldForwardRequestHeader(key) {
  return [
    "authorization",
    "content-type",
    "openai-organization",
    "openai-project",
    "idempotency-key",
    "anthropic-version",
    "anthropic-beta",
  ].includes(key) || key.startsWith("anthropic-");
}

function shouldUseNonStreamKeepAlive(req, isStream, parsedBody) {
  return NON_STREAM_KEEPALIVE &&
    !isStream &&
    canHaveBody(req.method) &&
    parsedBody &&
    !req.url?.includes("/embeddings");
}

function createDelayedJsonKeepAlive(res) {
  let started = false;
  let startTimer = null;
  let keepAliveTimer = null;

  const start = () => {
    if (started || res.headersSent || res.writableEnded) {
      return;
    }

    started = true;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "*",
    });

    // Leading JSON whitespace is valid and keeps Cloudflare/Render from
    // treating long non-streaming model calls as a silent origin.
    res.write("\n");
    keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write("\n");
      }
    }, NON_STREAM_KEEPALIVE_INTERVAL_MS);
    keepAliveTimer.unref?.();
  };

  startTimer = setTimeout(start, NON_STREAM_KEEPALIVE_START_MS);
  startTimer.unref?.();

  return {
    get started() {
      return started;
    },
    cancel() {
      clearTimeout(startTimer);
      clearInterval(keepAliveTimer);
    },
    finish(responseText) {
      clearTimeout(startTimer);
      clearInterval(keepAliveTimer);

      if (!started) {
        return false;
      }

      if (!res.writableEnded) {
        res.end(responseText);
      }
      return true;
    },
  };
}

function cancelJsonKeepAlive(jsonKeepAlive) {
  jsonKeepAlive?.cancel();
}

function finishJsonKeepAlive(jsonKeepAlive, data) {
  return finishJsonKeepAliveRaw(jsonKeepAlive, JSON.stringify(data, null, 2));
}

function finishJsonKeepAliveRaw(jsonKeepAlive, responseText) {
  if (!jsonKeepAlive?.started) {
    cancelJsonKeepAlive(jsonKeepAlive);
    return false;
  }

  return jsonKeepAlive.finish(responseText);
}

function shouldSkipResponseHeader(key) {
  return [
    "connection",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "keep-alive",
  ].includes(key.toLowerCase());
}

function isHtmlResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/html");
}

function isAliyunWafChallenge(body) {
  return body.includes("aliyun_waf_") ||
    body.includes("AliyunCaptcha") ||
    body.includes("CF_APP_WAF") ||
    body.includes('id="renderData"');
}

function isProxyPath(pathname) {
  return pathname === "/v1" || pathname.startsWith("/v1/") ||
    pathname === "/api/proxy/v1" || pathname.startsWith("/api/proxy/v1/");
}

function isValidProxyKey(req) {
  const supplied = getHeaderValue(req.headers, "x-proxy-key");
  return supplied && safeEqual(supplied, PROXY_SHARED_KEY);
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  if (first.length !== second.length) {
    return false;
  }

  return timingSafeEqual(first, second);
}

function isAdminApiPath(pathname) {
  return pathname === "/api/keys" ||
    pathname.startsWith("/api/keys/") ||
    pathname === "/api/keys/reveal" ||
    pathname === "/api/keys/subtract" ||
    pathname === "/api/keys/export.csv" ||
    pathname === "/api/stats";
}

function isAuthorizedAdmin(req) {
  if (!adminAuthRequired(req)) {
    return true;
  }

  if (!ADMIN_TOKEN) {
    return false;
  }

  const supplied =
    getHeaderValue(req.headers, "x-admin-token") ||
    getBearerToken(req.headers);

  return supplied && safeEqual(supplied, ADMIN_TOKEN);
}

function adminAuthRequired(req) {
  return Boolean(ADMIN_TOKEN) || !isLocalRequest(req);
}

function canUseServerApiKeyFallback(req) {
  return ALLOW_SERVER_KEY_PROXY ||
    isLocalRequest(req) ||
    Boolean(PROXY_SHARED_KEY && isValidProxyKey(req));
}

function canUseDirectUpstreamKeys(req) {
  return ALLOW_DIRECT_UPSTREAM_KEYS ||
    isLocalRequest(req) ||
    Boolean(PROXY_SHARED_KEY && isValidProxyKey(req));
}

function isLocalRequest(req) {
  const hostHeader = (req.headers.host || "").toLowerCase();
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];

  return ["localhost", "127.0.0.1", "::1"].includes(host);
}

async function serveStatic(url, res) {
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(join(publicDir, normalized));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: { message: "Forbidden" } });
    return;
  }

  if (!existsSync(filePath)) {
    const fallback = resolve(publicDir, "index.html");
    const html = await readFile(fallback, "utf8");
    res.writeHead(200, { "content-type": MIME_TYPES[".html"] });
    res.end(html);
    return;
  }

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ||
    "application/octet-stream";

  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

function addCorsHeaders(res, isAdmin = false) {
  if (!isAdmin) {
    res.setHeader("access-control-allow-origin", "*");
  }
  res.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-admin-token, x-agentrouter-key, x-agentrouter-api-key, x-proxy-key",
  );
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
}

function addSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function getHeaderValue(headers, headerName) {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value || "";
}

function getBearerToken(headers) {
  const authorization = getHeaderValue(headers, "authorization");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function getDirectUpstreamKey(headers) {
  return getHeaderValue(headers, "x-agentrouter-key") ||
    getHeaderValue(headers, "x-agentrouter-api-key") ||
    getBearerToken(headers);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function canHaveBody(method = "GET") {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function formatError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause instanceof Error ? `; cause: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);

  try {
    return JSON.parse(body.toString() || "{}");
  } catch {
    throw createHttpError(400, "Invalid JSON body");
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_REQUEST_BYTES) {
        settled = true;
        reject(createHttpError(413, `Request body exceeds ${MAX_REQUEST_BYTES} bytes`));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!settled) {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
  });
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
