# Зонк — онлайн-сервер

Весь сервер — один файл `index.js` (Node.js 18+, без зависимостей): подбор соперника по ставке, комнаты друзей по коду, правила и логика партии, WebSocket.

Render: Build Command `npm install`, Start Command `node index.js`, тариф Free.

Проверка: `https://<адрес>/health` → `{"ok":true,...}`.

Файлы `ws.js`, `match.js`, `rules.js` больше не используются — всё внутри `index.js`.
