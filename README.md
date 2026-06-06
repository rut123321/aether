# Aether - AgentRouter Endpoint

OpenAI-compatible endpoint для AgentRouter с системой управления кастомными API ключами и кредитами.

## Возможности

- **Управление кастомными ключами** - создание, удаление, копирование API ключей
- **Система кредитов** - автоматическое списание кредитов на основе токенов
- **Тёмная тема** - современный интерфейс в тёмных тонах
- **Статистика** - метрики использования ключей
- **FAQ** - гайд по подключению Claude Code CLI
- **Проверка баланса** - отдельная страница для проверки баланса ключа

## Локальный запуск

```bash
npm install
npm start
```

После запуска:

- Панель управления: `http://localhost:3000`
- API endpoint: `http://localhost:3000/v1`
- Проверка баланса: `http://localhost:3000/balance`
- FAQ: `http://localhost:3000/faq`

## Деплой на Render

1. Создайте GitHub репозиторий и загрузите файлы проекта
2. Зарегистрируйтесь на [render.com](https://render.com)
3. Создайте новый "Web Service"
4. Подключите GitHub репозиторий
5. Настройте:
   - **Name**: `aether`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment Variables**:
     - `AGENTROUTER_API_KEY`: ваш AgentRouter API ключ
     - `PORT`: `3000`
6. Разверните проект
7. Получите бесплатный поддомен: `https://aether.onrender.com`

## Переменные окружения

- `PORT` - порт сервера, по умолчанию `3000`
- `AGENTROUTER_BASE_URL` - upstream URL, по умолчанию `https://agentrouter.org/v1`
- `AGENTROUTER_API_KEY` - основной AgentRouter API ключ
- `PROXY_SHARED_KEY` - опциональный пароль для прокси
- `AGENTROUTER_CLIENT_PROFILE` - профиль заголовков, по умолчанию `codex`

## Использование как OpenAI-compatible endpoint

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "ваш-кастомный-ключ",
});

const response = await client.chat.completions.create({
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(response.choices[0].message.content);
```

## Система кредитов

- 1 кредит = 0.01 токенов
- 100M кредитов = 1M токенов
- Кредиты списываются автоматически при каждом запросе

## AgentRouter

- Документация: <https://docs.agentrouter.org/>
- Токены: <https://agentrouter.org/console/token>
