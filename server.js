import { createServer } from "node:http";
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
  return "sk-" + Array.from({ length: 32 }, () => 
    Math.random().toString(36)[2]).join("");
}

const PORT = Number(process.env.PORT || 3000);
const AGENTROUTER_BASE_URL = stripTrailingSlash(
  process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org/v1",
);
const DEFAULT_AGENTROUTER_API_KEY = process.env.AGENTROUTER_API_KEY || "";
const PROXY_SHARED_KEY = process.env.PROXY_SHARED_KEY || "";
const AGENTROUTER_CLIENT_PROFILE = process.env.AGENTROUTER_CLIENT_PROFILE || "codex";
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

const server = createServer(async (req, res) => {
  try {
    addCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        upstreamBaseUrl: AGENTROUTER_BASE_URL,
        clientProfile: AGENTROUTER_CLIENT_PROFILE,
        hasServerApiKey: Boolean(DEFAULT_AGENTROUTER_API_KEY),
        requiresProxyKey: Boolean(PROXY_SHARED_KEY),
      });
      return;
    }

    if (url.pathname === "/api/config") {
      sendJson(res, 200, {
        proxyBasePath: "/v1",
        upstreamBaseUrl: AGENTROUTER_BASE_URL,
        clientProfile: AGENTROUTER_CLIENT_PROFILE,
        docsUrl: "https://docs.agentrouter.org/",
        tokenUrl: "https://agentrouter.org/console/token",
      });
      return;
    }

    // API Key management endpoints
    if (url.pathname === "/api/keys" && req.method === "GET") {
      const keysList = Object.entries(apiKeys).map(([key, data]) => ({
        key: key.slice(0, 8) + "..." + key.slice(-4),
        fullKey: key,
        name: data.name,
        credits: data.credits,
        createdAt: data.createdAt,
      }));
      sendJson(res, 200, { keys: keysList });
      return;
    }

    if (url.pathname === "/api/keys" && req.method === "POST") {
      const body = await readRequestBody(req);
      const { name, credits } = JSON.parse(body.toString());
      const newKey = generateApiKey();
      apiKeys[newKey] = {
        name,
        credits: Number(credits),
        createdAt: new Date().toISOString(),
      };
      await saveKeys();
      sendJson(res, 201, { key: newKey, name, credits: apiKeys[newKey].credits });
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

    if (url.pathname === "/api/balance" && req.method === "POST") {
      const body = await readRequestBody(req);
      const { key } = JSON.parse(body.toString());
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

    await serveStatic(url, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: {
          message: "Internal proxy error",
          detail: formatError(error),
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
  const customApiKey = getHeaderValue(req.headers, "authorization")?.replace("Bearer ", "");
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

  const upstreamUrl = buildUpstreamUrl(incomingUrl);
  const headers = buildUpstreamHeaders(req.headers, usingCustomKey);
  const requestBody = canHaveBody(req.method) ? await readRequestBody(req) : undefined;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: requestBody,
    redirect: "manual",
  });

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
    const isStream = requestBody && requestBody.toString().includes('"stream":true');
    
    if (isStream) {
      // Handle streaming response to deduct credits
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let totalTokens = 0;

      const stream = new Readable({
        read() {}
      });

      reader.read().then(async function process({ done, value }) {
        if (done) {
          stream.push(null);
          // Deduct credits (1 credit = 100 tokens)
          const creditsToDeduct = Math.ceil(totalTokens * 100);
          if (creditsToDeduct > 0) {
            apiKeys[customApiKey].credits -= creditsToDeduct;
            await saveKeys();
          }
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        stream.push(chunk);

        // Try to extract token usage from streaming response
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) {
                totalTokens += parsed.usage.total_tokens || 0;
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
        const creditsToDeduct = Math.ceil(totalTokens * 100);
        if (creditsToDeduct > 0) {
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

function buildUpstreamUrl(incomingUrl) {
  const proxyPath = incomingUrl.pathname.startsWith("/api/proxy/v1")
    ? incomingUrl.pathname.replace(/^\/api\/proxy\/v1/, "")
    : incomingUrl.pathname.replace(/^\/v1/, "");

  const pathname = `${AGENTROUTER_BASE_URL}${proxyPath || ""}`;
  return `${pathname}${incomingUrl.search}`;
}

function buildUpstreamHeaders(incomingHeaders, usingCustomKey = false) {
  const headers = {};

  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lowerKey = key.toLowerCase();
    if (shouldSkipRequestHeader(lowerKey)) {
      continue;
    }

    headers[lowerKey] = Array.isArray(value) ? value.join(", ") : value;
  }

  // If using custom key, always use the default AgentRouter API key for upstream
  // Otherwise, check for browser-provided key
  if (usingCustomKey) {
    if (DEFAULT_AGENTROUTER_API_KEY) {
      headers.authorization = `Bearer ${DEFAULT_AGENTROUTER_API_KEY}`;
    }
  } else {
    const browserSelectedKey =
      getHeaderValue(incomingHeaders, "x-agentrouter-key") ||
      getHeaderValue(incomingHeaders, "x-agentrouter-api-key");

    if (browserSelectedKey) {
      headers.authorization = `Bearer ${browserSelectedKey}`;
    } else if (DEFAULT_AGENTROUTER_API_KEY) {
      headers.authorization = `Bearer ${DEFAULT_AGENTROUTER_API_KEY}`;
    }
  }

  delete headers["x-agentrouter-key"];
  delete headers["x-agentrouter-api-key"];
  delete headers["x-proxy-key"];

  applyClientProfile(headers);

  return headers;
}

function applyClientProfile(headers) {
  if (AGENTROUTER_CLIENT_PROFILE === "none") {
    return;
  }

  if (AGENTROUTER_CLIENT_PROFILE === "codex") {
    headers.originator = "codex_cli_rs";
    headers["user-agent"] = CODEX_COMPAT_USER_AGENT;
    headers.version = CODEX_COMPAT_VERSION;
  }
}

function shouldSkipRequestHeader(key) {
  return [
    "host",
    "connection",
    "content-length",
    "expect",
    "accept-encoding",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
  ].includes(key);
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

function isProxyPath(pathname) {
  return pathname === "/v1" || pathname.startsWith("/v1/") ||
    pathname === "/api/proxy/v1" || pathname.startsWith("/api/proxy/v1/");
}

function isValidProxyKey(req) {
  const supplied = getHeaderValue(req.headers, "x-proxy-key");
  return supplied && safeEqual(supplied, PROXY_SHARED_KEY);
}

function safeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
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

function addCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-agentrouter-key, x-agentrouter-api-key, x-proxy-key",
  );
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
}

function getHeaderValue(headers, headerName) {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value || "";
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

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}
