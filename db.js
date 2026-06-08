// Thin Supabase REST client for the api_keys table.
// Uses fetch (built-in on Node 18+) — no SDK needed.

const SUPABASE_URL = stripTrailingSlash(process.env.SUPABASE_URL || "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. " +
    "See .env.example.",
  );
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
const BASE_HEADERS = {
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
};

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function request(path, init = {}) {
  const response = await fetch(`${REST}${path}`, {
    ...init,
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${response.status}: ${text}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function listKeys() {
  return request("/api_keys?select=key,name,credits,created_at&order=created_at.desc");
}

export async function getKey(key) {
  const rows = await request(
    `/api_keys?key=eq.${encodeURIComponent(key)}&select=key,name,credits,created_at&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function findKeyByPartial(prefix, suffix) {
  const params = new URLSearchParams({
    select: "key,name,credits,created_at",
    key: `like.${prefix}*${suffix}`,
    limit: "1",
  });
  const rows = await request(`/api_keys?${params.toString()}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function insertKey({ key, name, credits }) {
  const rows = await request("/api_keys", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ key, name, credits }),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function deleteKey(key) {
  const rows = await request(
    `/api_keys?key=eq.${encodeURIComponent(key)}`,
    { method: "DELETE", headers: { prefer: "return=representation" } },
  );
  return Array.isArray(rows) && rows.length > 0;
}

export async function addCredits(key, amount) {
  const current = await getKey(key);
  if (!current) return null;
  const next = current.credits + amount;
  const rows = await request(
    `/api_keys?key=eq.${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ credits: next }),
    },
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function subtractCredits(key, amount) {
  const current = await getKey(key);
  if (!current) return null;
  const next = Math.max(0, current.credits - amount);
  const rows = await request(
    `/api_keys?key=eq.${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ credits: next }),
    },
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function deductCredits(key, amount) {
  const result = await request("/rpc/deduct_credits", {
    method: "POST",
    body: JSON.stringify({ p_key: key, p_amount: amount }),
  });
  return typeof result === "number" ? result : result;
}

export async function stats() {
  const rows = await listKeys();
  const totalKeys = rows.length;
  const totalCredits = rows.reduce((sum, r) => sum + Number(r.credits || 0), 0);
  const activeKeys = rows.filter((r) => Number(r.credits) > 0).length;
  return { totalKeys, totalCredits, activeKeys };
}

export async function logUsage({ key, model, tokens, credits }) {
  try {
    await request("/usage_log", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ key, model, tokens, credits }),
    });
  } catch (err) {
    // Don't fail the request if logging is broken (e.g. usage_log table not created yet).
    console.error("logUsage failed:", err.message);
  }
}

export async function recentUsage(key, limit = 10) {
  const params = new URLSearchParams({
    select: "model,tokens,credits,created_at",
    key: `eq.${key}`,
    order: "created_at.desc",
    limit: String(limit),
  });
  try {
    const rows = await request(`/usage_log?${params.toString()}`);
    return rows || [];
  } catch (err) {
    // usage_log table may not exist yet (migration 002 not applied). Don't break /balance.
    console.error("recentUsage failed:", err.message);
    return [];
  }
}
