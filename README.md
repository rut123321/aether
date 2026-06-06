# Aether - AgentRouter Endpoint

OpenAI-compatible endpoint для AgentRouter с панелью управления кастомными ключами и кредитами.

## Что важно для публичного деплоя

Этот проект является HTTP-прокси к `AGENTROUTER_BASE_URL`. На бесплатных PaaS-хостингах открытые прокси часто блокируются или быстро попадают под антиабьюз. Поэтому по умолчанию проект теперь:

- не подменяет `User-Agent` под Codex/Claude CLI;
- требует `ADMIN_TOKEN` для `/api/keys` и `/api/stats` на публичном хосте;
- запрещает публичный direct-upstream режим с чужими AgentRouter-ключами;
- не отдает серверный `AGENTROUTER_API_KEY` всем публичным запросам;
- ограничивает размер входящего запроса через `MAX_REQUEST_BYTES`.

Нельзя гарантировать, что какой-либо бесплатный хост никогда не будет заблокирован upstream WAF. Если upstream блокирует IP датацентра, нужен другой egress IP, allowlist у upstream или VPS с отдельным IP.

## Ошибка Aliyun WAF на Render/Railway

Если вместо JSON API-ответа приходит HTML со строками вроде `aliyun_waf_aa`, `AliyunCaptcha`, `CF_APP_WAF` или `renderData`, сайт работает, но upstream AgentRouter вернул browser verification page. Это означает:

- запрос с Render/Railway дошел до AgentRouter;
- блокировка происходит на стороне WAF AgentRouter;
- серверный `fetch()` не может пройти slider/captcha verification как браузер.

Сервер распознает такой ответ и возвращает JSON:

```json
{
  "error": {
    "code": "UPSTREAM_WAF_CHALLENGE",
    "message": "AgentRouter returned an Aliyun WAF browser verification page instead of an API response."
  }
}
```

В коде включен WAF-safe режим для Render/Railway:

- upstream получает минимальный набор API-заголовков, без `x-forwarded-*`, `forwarded`, `via`, `x-real-ip`, `x-render-*`, `x-railway-*`;
- первый запрос идет как обычный server-to-server API request;
- если пришел Aliyun WAF HTML, сервер повторяет запрос с compatibility-профилем `codex`;
- если оба профиля получили WAF HTML, значит проблема почти наверняка в egress IP Render/Railway, а не в коде.

Рабочие варианты:

- попросить AgentRouter дать server-to-server endpoint или allowlist для IP хостинга;
- использовать VPS/VM с другим egress IP;
- держать endpoint на машине/сервере, с которого AgentRouter не показывает WAF verification;
- сменить хостинг и проверить конкретный egress IP, но бесплатный PaaS не дает гарантии.

## Локальный запуск

```bash
npm install
npm start
```

После запуска:

- панель управления: `http://localhost:3000`
- API endpoint: `http://localhost:3000/v1`
- проверка баланса: `http://localhost:3000/balance`
- FAQ: `http://localhost:3000/faq`

## Переменные окружения

Обязательные для публичного деплоя:

- `AGENTROUTER_API_KEY` - основной AgentRouter API ключ для кастомных endpoint-ключей.
- `ADMIN_TOKEN` - токен администратора для API управления ключами.
- `ADMIN_PASSWORD` - пароль для доступа к админ панели в интерфейсе (по умолчанию генерируется случайно; рекомендуется задать явно, например `viti123`).

Рекомендуемые/опциональные:

- `PORT` - порт сервера, по умолчанию `3000`.
- `AGENTROUTER_BASE_URL` - upstream URL, по умолчанию `https://agentrouter.org/v1`.
- `AGENTROUTER_CLIENT_PROFILE` - профиль заголовков. По умолчанию `none`. Значение `codex` включает совместимые заголовки, но на публичном хостинге может выглядеть подозрительно.
- `UPSTREAM_WAF_RETRY` - повторить upstream-запрос вторым профилем заголовков, если AgentRouter вернул Aliyun WAF HTML. По умолчанию `true`.
- `UPSTREAM_USER_AGENT` - обычный server-to-server User-Agent для первого upstream-запроса, по умолчанию `AetherEndpoint/1.0`.
- `MAX_REQUEST_BYTES` - лимит тела запроса, по умолчанию `20971520`.
- `PROXY_SHARED_KEY` - дополнительный общий ключ для `/v1`, если нужно закрыть прокси от всех, кроме доверенных клиентов.
- `ALLOW_DIRECT_UPSTREAM_KEYS=true` - разрешает публичным клиентам проксировать свои AgentRouter-ключи через `Authorization` или `x-agentrouter-key`. По умолчанию выключено.
- `ALLOW_SERVER_KEY_PROXY=true` - опасный режим: разрешает публичным запросам без кастомного ключа использовать серверный `AGENTROUTER_API_KEY`. Не включайте на публичном бесплатном хостинге.

## Деплой

### Render

Настройки Web Service:

- Build Command: `npm install`
- Start Command: `npm start`
- Environment:
  - `AGENTROUTER_API_KEY`
  - `ADMIN_TOKEN`
  - `AGENTROUTER_CLIENT_PROFILE=none`
  - `UPSTREAM_WAF_RETRY=true`
  - `UPSTREAM_USER_AGENT=AetherEndpoint/1.0`

Если WAF был из-за forwarded/proxy headers, этот вариант должен перестать получать Aliyun verification page.

### Railway

Railway обычно подхватывает Node-проект через Nixpacks:

- Start Command: `npm start`
- Variables:
  - `AGENTROUTER_API_KEY`
  - `ADMIN_TOKEN`
  - `AGENTROUTER_CLIENT_PROFILE=none`
  - `UPSTREAM_WAF_RETRY=true`
  - `UPSTREAM_USER_AGENT=AetherEndpoint/1.0`

Если после этого все равно приходит `UPSTREAM_WAF_CHALLENGE`, значит AgentRouter режет сам egress IP Railway, а не заголовки запроса.

## Использование как OpenAI-compatible endpoint

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://your-host.example/v1",
  apiKey: "ваш-кастомный-ключ",
});

const response = await client.chat.completions.create({
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(response.choices[0].message.content);
```

## Хранение ключей

Кастомные ключи пишутся в `data/keys.json`. На бесплатных PaaS этот файл может потеряться при redeploy/restart. Для настоящего продакшена лучше заменить файл на внешнюю базу: Postgres, Redis, SQLite на постоянном диске или managed KV.

## Система кредитов

- 10 кредитов = 1 токен.
- 10M кредитов = 1M токенов.
- Кредиты списываются автоматически, когда upstream возвращает usage.

## AgentRouter

- Документация: <https://docs.agentrouter.org/>
- Токены: <https://agentrouter.org/console/token>
