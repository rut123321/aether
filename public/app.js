const STORAGE_KEYS = {
  keys: "agentrouter-endpoint.keys",
  activeId: "agentrouter-endpoint.activeId",
};

const elements = {
  serverStatus: document.querySelector("#serverStatus"),
  localBaseUrl: document.querySelector("#localBaseUrl"),
  keyForm: document.querySelector("#keyForm"),
  keyName: document.querySelector("#keyName"),
  apiKey: document.querySelector("#apiKey"),
  activeKeySelect: document.querySelector("#activeKeySelect"),
  revealKeyButton: document.querySelector("#revealKeyButton"),
  deleteKeyButton: document.querySelector("#deleteKeyButton"),
  chatForm: document.querySelector("#chatForm"),
  modelInput: document.querySelector("#modelInput"),
  messageInput: document.querySelector("#messageInput"),
  streamInput: document.querySelector("#streamInput"),
  testKeySelect: document.querySelector("#testKeySelect"),
  responseOutput: document.querySelector("#responseOutput"),
  createKeyForm: document.querySelector("#createKeyForm"),
  newKeyName: document.querySelector("#newKeyName"),
  newKeyCredits: document.querySelector("#newKeyCredits"),
  customKeysList: document.querySelector("#customKeysList"),
  totalKeys: document.querySelector("#totalKeys"),
  totalCredits: document.querySelector("#totalCredits"),
  activeKeys: document.querySelector("#activeKeys"),
};

let keys = loadKeys();
let activeId = localStorage.getItem(STORAGE_KEYS.activeId) || keys[0]?.id || "";

boot();

async function boot() {
  renderEndpointInfo();
  renderKeys();
  bindEvents();
  await checkServer();
  await loadCustomKeys();
  await loadStats();
  initTabs();
}

function bindEvents() {
  elements.keyForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const name = elements.keyName.value.trim();
    const value = elements.apiKey.value.trim();

    if (!name || !value) {
      return;
    }

    const key = {
      id: crypto.randomUUID(),
      name,
      value,
      createdAt: new Date().toISOString(),
    };

    keys = [key, ...keys];
    activeId = key.id;
    saveKeys();
    renderKeys();
    elements.keyForm.reset();
  });

  elements.activeKeySelect.addEventListener("change", () => {
    activeId = elements.activeKeySelect.value;
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);
  });

  elements.revealKeyButton.addEventListener("click", () => {
    const activeKey = getActiveKey();
    if (!activeKey) {
      showOutput("Сначала добавь или выбери API key.");
      return;
    }

    showOutput(`${activeKey.name}: ${activeKey.value}`);
  });

  elements.deleteKeyButton.addEventListener("click", () => {
    const activeKey = getActiveKey();
    if (!activeKey) {
      return;
    }

    const confirmed = window.confirm(`Удалить ключ "${activeKey.name}" из этого браузера?`);
    if (!confirmed) {
      return;
    }

    keys = keys.filter((key) => key.id !== activeKey.id);
    activeId = keys[0]?.id || "";
    saveKeys();
    renderKeys();
  });

  elements.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendChatRequest();
  });

  elements.createKeyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createCustomKey();
  });

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.querySelector(`#${button.dataset.copyTarget}`);
      await navigator.clipboard.writeText(target.textContent.trim());
      const previous = button.textContent;
      button.textContent = "✓";
      window.setTimeout(() => {
        button.textContent = previous;
      }, 900);
    });
  });
}

async function sendChatRequest() {
  const model = elements.modelInput.value.trim();
  const message = elements.messageInput.value.trim();
  const stream = elements.streamInput.checked;
  const testKey = elements.testKeySelect.value;

  if (!model || !message) {
    showOutput("Model и Message не должны быть пустыми.");
    return;
  }

  showOutput("Отправляю запрос...");

  try {
    const headers = {
      "content-type": "application/json",
    };

    // Use custom key if selected, otherwise use AgentRouter key from localStorage
    if (testKey) {
      headers["authorization"] = `Bearer ${testKey}`;
    } else {
      const activeKey = getActiveKey();
      if (!activeKey) {
        showOutput("Добавь AgentRouter API key или выбери кастомный ключ для теста.");
        return;
      }
      headers["x-agentrouter-key"] = activeKey.value;
    }

    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
        stream,
      }),
    });

    if (stream) {
      await handleStreamResponse(response);
    } else {
      await handleNormalResponse(response);
    }
  } catch (error) {
    showOutput(`Ошибка запроса: ${error.message}`);
  }
}

async function handleNormalResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  // Handle double-encoded JSON (string wrapped in quotes)
  if (typeof data === "string" && data.startsWith('"')) {
    try {
      data = JSON.parse(data);
    } catch {
      // Not double-encoded, keep as string
    }
  }

  if (data.choices && data.choices[0] && data.choices[0].message) {
    showOutput(data.choices[0].message.content);
  } else {
    showOutput(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
}

async function handleStreamResponse(response) {
  if (!response.body) {
    showOutput("Нет ответа от сервера");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";

  showOutput("");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
            const content = parsed.choices[0].delta.content || "";
            fullContent += content;
            showOutput(fullContent);
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }
}

async function checkServer() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("Health check failed");
    const data = await response.json();
    elements.serverStatus.classList.toggle("ok", data.ok);
    elements.serverStatus.lastChild.textContent = data.ok ? "Онлайн" : "Ошибка";
  } catch (error) {
    console.error("Health check error:", error);
    elements.serverStatus.classList.remove("ok");
    elements.serverStatus.lastChild.textContent = "Офлайн";
  }
}

function renderEndpointInfo() {
  const baseUrl = `${window.location.origin}/v1`;
  elements.localBaseUrl.textContent = baseUrl;
  // renderSnippets() - removed as snippets section is not in new design
}

function renderKeys() {
  if (!keys.some((key) => key.id === activeId)) {
    activeId = keys[0]?.id || "";
  }

  elements.activeKeySelect.innerHTML = "";

  if (!keys.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Нет сохраненных ключей";
    elements.activeKeySelect.append(option);
    elements.activeKeySelect.disabled = true;
  } else {
    for (const key of keys) {
      const option = document.createElement("option");
      option.value = key.id;
      option.textContent = `${key.name} (${maskKey(key.value)})`;
      option.selected = key.id === activeId;
      elements.activeKeySelect.append(option);
    }
    elements.activeKeySelect.disabled = false;
  }

  localStorage.setItem(STORAGE_KEYS.activeId, activeId);
}

function saveKeys() {
  localStorage.setItem(STORAGE_KEYS.keys, JSON.stringify(keys));
  localStorage.setItem(STORAGE_KEYS.activeId, activeId);
}

function loadKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.keys) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getActiveKey() {
  return keys.find((key) => key.id === activeId);
}

function maskKey(value) {
  if (value.length <= 10) {
    return "hidden";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function showOutput(value) {
  elements.responseOutput.textContent = value;
}

async function loadCustomKeys() {
  try {
    const response = await fetch("/api/keys");
    const data = await response.json();
    renderCustomKeys(data.keys);
  } catch (error) {
    elements.customKeysList.innerHTML = `<p>Ошибка загрузки: ${error.message}</p>`;
  }
}

function renderCustomKeys(keys) {
  if (!keys || keys.length === 0) {
    elements.customKeysList.innerHTML = "<p>Нет созданных ключей</p>";
    elements.testKeySelect.innerHTML = '<option value="">Без ключа (использовать AgentRouter ключ)</option>';
    return;
  }

  elements.customKeysList.innerHTML = keys.map((key) => `
    <div class="key-item">
      <div class="key-info">
        <strong>${key.name}</strong>
        <code>${key.key}</code>
        <span>Кредиты: ${key.credits}</span>
      </div>
      <div class="key-actions">
        <button class="icon-button" onclick="copyToClipboard('${key.fullKey}')" title="Копировать">⧉</button>
        <button class="danger-button" onclick="deleteCustomKey('${key.fullKey}')" title="Удалить">✕</button>
      </div>
    </div>
  `).join("");

  // Update test key select dropdown
  elements.testKeySelect.innerHTML = '<option value="">Без ключа (использовать AgentRouter ключ)</option>' +
    keys.map((key) => `<option value="${key.fullKey}">${key.name} (${key.credits} кредитов)</option>`).join("");
}

async function createCustomKey() {
  const name = elements.newKeyName.value.trim();
  const credits = elements.newKeyCredits.value;

  if (!name || !credits) {
    showToast("Заполните все поля", "error");
    return;
  }

  try {
    const response = await fetch("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, credits }),
    });

    if (response.ok) {
      const data = await response.json();
      showToast(`Ключ создан: ${data.key.slice(0, 8)}...${data.key.slice(-4)}`, "success");
      elements.createKeyForm.reset();
      await loadCustomKeys();
      await loadStats();
    } else {
      showToast("Ошибка создания ключа", "error");
    }
  } catch (error) {
    showToast(`Ошибка: ${error.message}`, "error");
  }
}

async function deleteCustomKey(fullKey) {
  if (!confirm("Удалить этот ключ?")) return;

  try {
    const response = await fetch(`/api/keys/${fullKey}`, { method: "DELETE" });
    if (response.ok) {
      showToast("Ключ удален", "success");
      await loadCustomKeys();
      await loadStats();
    } else {
      showToast("Ошибка удаления", "error");
    }
  } catch (error) {
    showToast(`Ошибка: ${error.message}`, "error");
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text);
  showToast("Ключ скопирован!", "success");
}

// Tab system
function initTabs() {
  const navItems = document.querySelectorAll(".nav-item");
  const tabContents = document.querySelectorAll(".tab-content");

  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tabId = item.dataset.tab;

      // Update nav items
      navItems.forEach((nav) => nav.classList.remove("active"));
      item.classList.add("active");

      // Update tab contents
      tabContents.forEach((content) => {
        content.classList.remove("active");
        if (content.id === tabId) {
          content.classList.add("active");
        }
      });
    });
  });
}

// Load statistics
async function loadStats() {
  try {
    const response = await fetch("/api/stats");
    const data = await response.json();

    elements.totalKeys.textContent = data.totalKeys || 0;
    elements.totalCredits.textContent = formatNumber(data.totalCredits || 0);
    elements.activeKeys.textContent = data.activeKeys || 0;
  } catch (error) {
    console.error("Error loading stats:", error);
  }
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K";
  }
  return num.toString();
}

// Toast notifications
function showToast(message, type = "success") {
  const container = document.querySelector(".toast-container") || createToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

function createToastContainer() {
  const container = document.createElement("div");
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
}

// Make functions globally available for onclick handlers
window.deleteCustomKey = deleteCustomKey;
window.copyToClipboard = copyToClipboard;
