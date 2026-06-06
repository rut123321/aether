import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const dataDir = resolve(__dirname, "data");
const keysFile = resolve(dataDir, "keys.json");

// Ensure data directory exists
await mkdir(dataDir, { recursive: true });

// Load or initialize keys database
let apiKeys = await loadKeys();

async function loadKeys() {
  try {
    const data = await readFile(keysFile, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveKeys() {
  await writeFile(keysFile, JSON.stringify(apiKeys, null, 2));
}

function generateApiKey() {
  return `sk-${randomBytes(32).toString("hex")}`;
}

// Session management
const SESSION_SECRET = randomBytes(32).toString("hex");
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
  if (!token || !activeSessions.has(token)) return false;
  return true;
}

function clearSession(token) {
  activeSessions.delete(token);
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
const ALLOW_DIRECT_UPSTREAM_KEYS = process.env.ALLOW_DIRECT_UPSTREAM_KEYS === "true";
const ALLOW_SERVER_KEY_PROXY = process.env.ALLOW_SERVER_KEY_PROXY === "true";
const ALLOWED_MODELS = ["claude-opus-4-7", "glm-5.1"];
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
      if (password === ADMIN_PASSWORD) {
        const token = createSession();
        res.setHeader("Set-Cookie", `aether_session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`);
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
      res.setHeader("Set-Cookie", "aether_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict");
      sendJson(res, 200, { success: true });
      return;
    }

    // API Key management endpoints
    if (url.pathname === "/api/keys" && req.method === "GET") {
      const keysList = Object.entries(apiKeys).map(([key, data]) => ({
        key: key.slice(0, 8) + "..." + key.slice(-4),
        name: data.name,
        credits: data.credits,
        createdAt: data.createdAt,
      }));
      sendJson(res, 200, { keys: keysList });
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
      const matchedKey = Object.keys(apiKeys).find((k) => k.startsWith(prefix) && k.endsWith(suffix));
      if (matchedKey) {
        sendJson(res, 200, { fullKey: matchedKey, name: apiKeys[matchedKey].name });
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
      apiKeys[newKey] = {
        name: normalizedName,
        credits: Math.floor(normalizedCredits),
        createdAt: new Date().toISOString(),
      };
      await saveKeys();
      sendJson(res, 201, {
        key: newKey,
        name: normalizedName,
        credits: apiKeys[newKey].credits,
      });
      return;
    }

    if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
      const keyToDelete = url.pathname.slice("/api/keys/".length);
      if (apiKeys[keyToDelete]) {
        delete apiKeys[keyToDelete];
        await saveKeys();
        sendJson(res, 200, { message: "Key deleted" });
      } else {
        sendJson(res, 404, { error: "Key not found" });
      }
      return;
    }

    // Add credits to existing key
    if (url.pathname.startsWith("/api/keys/") && req.method === "POST") {
      const keyToAddCredits = url.pathname.slice("/api/keys/".length);
      const { credits } = await readJsonBody(req);
      const creditsToAdd = Number(credits);

      if (!apiKeys[keyToAddCredits]) {
        sendJson(res, 404, { error: "Key not found" });
        return;
      }

      if (!Number.isFinite(creditsToAdd) || creditsToAdd <= 0) {
        sendJson(res, 400, { error: "Credits must be a positive number" });
        return;
      }

      apiKeys[keyToAddCredits].credits += Math.floor(creditsToAdd);
      await saveKeys();
      sendJson(res, 200, {
        message: "Credits added",
        key: keyToAddCredits,
        name: apiKeys[keyToAddCredits].name,
        credits: apiKeys[keyToAddCredits].credits,
      });
      return;
    }

    if (url.pathname === "/api/balance" && req.method === "POST") {
      const { key } = await readJsonBody(req);
      if (apiKeys[key]) {
        sendJson(res, 200, { balance: apiKeys[key].credits, name: apiKeys[key].name });
      } else {
        sendJson(res, 404, { error: "Key not found" });
      }
      return;
    }

    if (url.pathname === "/api/stats" && req.method === "GET") {
      const keysList = Object.entries(apiKeys);
      const totalKeys = keysList.length;
      const totalCredits = keysList.reduce((sum, [key, data]) => sum + data.credits, 0);
      const activeKeys = keysList.filter(([key, data]) => data.credits > 0).length;
      sendJson(res, 200, { totalKeys, totalCredits, activeKeys });
      return;
    }

    if (isProxyPath(url.pathname)) {
      await proxyToAgentRouter(req, res, url);
      return;
    }

    if (url.pathname === "/balance") {
      const balanceHtml = await readFile(resolve(publicDir, "balance.html"), "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
      });
      res.end(balanceHtml);
      return;
    }

    if (url.pathname === "/faq") {
      const faqHtml = await readFile(resolve(publicDir, "faq.html"), "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
      });
      res.end(faqHtml);
      return;
    }

    // Protect admin panel assets — require server-side session
    const protectedPaths = ["/", "/index.html", "/app.js", "/styles.css"];
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

  if (customApiKey && apiKeys[customApiKey]) {
    keyData = apiKeys[customApiKey];
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
  const requestBody = canHaveBody(req.method) ? await readRequestBody(req) : undefined;

  // Validate model if present in request body
  if (requestBody && requestBody.model) {
    const requestedModel = String(requestBody.model);
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

  const upstreamResult = await fetchUpstreamWithWafRetry(
    req,
    upstreamUrl,
    usingCustomKey,
    requestBody,
  );

  if (upstreamResult.wafChallenge) {
    sendJson(res, 502, {
      error: {
        code: "UPSTREAM_WAF_CHALLENGE",
        message: "AgentRouter returned an Aliyun WAF browser verification page instead of an API response.",
        hint: "The request reached AgentRouter. Clean API headers and the compatibility retry were both challenged, so this is likely a Render/Railway egress IP block. Ask AgentRouter for allowlist/server-to-server access or use a different outbound IP.",
        upstreamStatus: upstreamResult.status,
        upstreamBaseUrl: AGENTROUTER_BASE_URL,
        attemptedProfiles: upstreamResult.attemptedProfiles,
      },
    });
    return;
  }

  if (upstreamResult.htmlResponse) {
    res.writeHead(upstreamResult.status, {
      "content-type": upstreamResult.contentType || "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(upstreamResult.responseText);
    return;
  }

  const upstreamResponse = upstreamResult.response;

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
    // Check if this is a streaming request
    let isStream = false;
    if (requestBody) {
      try {
        const body = JSON.parse(requestBody.toString());
        isStream = body.stream === true;
      } catch {}
    }

    if (isStream) {
      // Handle streaming response to deduct credits
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let totalTokens = 0;
      let responseCharCount = 0;
      const requestCharCount = requestBody ? requestBody.toString().length : 0;

      const stream = new Readable({
        read() {}
      });

      reader.read().then(async function process({ done, value }) {
        if (done) {
          stream.push(null);
          // Fallback: estimate tokens from characters if usage not provided (~4 chars = 1 token)
          const estimatedTokens = totalTokens || Math.ceil((requestCharCount + responseCharCount) / 4);
          const creditsToDeduct = Math.ceil(Math.max(estimatedTokens, 1) * 100);
          if (creditsToDeduct > 0 && apiKeys[customApiKey]) {
            apiKeys[customApiKey].credits -= creditsToDeduct;
            await saveKeys();
          }
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        stream.push(chunk);
        responseCharCount += chunk.length;

        // Try to extract token usage from streaming response
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage && parsed.usage.total_tokens) {
                totalTokens = parsed.usage.total_tokens;
              }
            } catch {}
          }
        }

        reader.read().then(process);
      });

      stream.pipe(res);
    } else {
      // Handle non-streaming response
      const responseText = await upstreamResponse.text();
      try {
        const responseData = JSON.parse(responseText);
        const totalTokens = responseData.usage?.total_tokens || 0;
        const creditsToDeduct = Math.ceil(Math.max(totalTokens, 1) * 100);
        if (creditsToDeduct > 0 && apiKeys[customApiKey]) {
          apiKeys[customApiKey].credits -= creditsToDeduct;
          await saveKeys();
        }
        res.end(responseText);
      } catch {
        res.end(responseText);
      }
    }
  } else {
    Readable.fromWeb(upstreamResponse.body).pipe(res);
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
    res.writeHead(200, {
      "content-type": MIME_TYPES[".html"],
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
    });
    res.end(html);
    return;
  }

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ||
    "application/octet-stream";

  const extraHeaders = {
    "cache-control": "no-store",
  };
  if (contentType === "text/html; charset=utf-8") {
    extraHeaders["content-security-policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';";
  }
  res.writeHead(200, {
    "content-type": contentType,
    ...extraHeaders,
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
