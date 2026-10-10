// ─────────────────────────────────────────────────────────────
//  ЗОНК — онлайн-сервер.
//  • подбор соперника по ставке (1 000 / 10 000 / 50 000);
//  • комнаты друзей по 4-символьному коду (без ставок);
//  • вся логика партии и броски — здесь (ZonkMatch), клиент только
//    показывает события;
//  • таймер хода, автоход за отключившегося игрока, поражение,
//    если игрок не вернулся за 90 секунд.
//  Без внешних зависимостей: `node index.js`.
// ─────────────────────────────────────────────────────────────
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { accept } from './ws.js';
import { ZonkMatch, PHASE } from './shared/match.js';

const PORT = Number(process.env.PORT) || 8080;
const STAKES = [1000, 10000, 50000];
const TURN_MS = 30_000;          // время на действие (как таймер у клиента)
const ANIM_MS = 12_000;          // запас на анимации у клиентов
const OFFLINE_ACT_MS = 7_000;    // если игрок отключён — ходим за него быстрее
const FORFEIT_MS = 90_000;       // не вернулся — поражение
const SESSION_TTL = 15 * 60_000; // забываем неактивных
const ALPH = 'АБВГДЕКМНПРСТХ23456789';
const VERSION = 1;

const root = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** @type {Map<string, Session>} */
const sessions = new Map();
const queues = new Map(STAKES.map((s) => [s, []]));
const rooms = new Map(); // code → session
const games = new Set();
let seq = 0;

class Session {
  constructor(token) {
    this.token = token;
    this.id = `p${++seq}`;
    this.name = 'Игрок'; this.avatar = null; this.dice = 'classic';
    this.sock = null; this.online = false; this.seen = Date.now();
    this.game = null; this.queued = 0; this.room = null;
  }
  send(m) { if (this.online) this.sock.send(m); }
}

const clean = (s, n) => String(s ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, n);
const onlineCount = () => [...sessions.values()].filter((s) => s.online).length;

// ── партия ────────────────────────────────────────────────
class Game {
  constructor(a, b, mode, stake) {
    this.mode = mode; this.stake = stake;
    this.seats = Math.random() < 0.5 ? [a, b] : [b, a];
    this.m = new ZonkMatch({ players: this.seats.map((s) => ({ id: s.id, name: s.name, avatar: s.avatar })) });
    this.timer = null; this.forfeitTimers = new Map();
    this.actionAt = Date.now();
    games.add(this);
    for (const s of this.seats) { s.game = this; dequeue(s); closeRoom(s); }
    this.seats.forEach((s, i) => {
      const o = this.seats[1 - i];
      s.send({ t: 'start', you: i, mode, stake, view: this.m.view(), opp: { name: o.name, avatar: o.avatar, dice: o.dice }, me: { dice: s.dice } });
    });
    log(`start ${mode} ${stake} ${a.name} vs ${b.name}`);
    this._schedule(ANIM_MS / 2);
  }

  seatOf(s) { return this.seats.indexOf(s); }
  other(s) { return this.seats[1 - this.seatOf(s)]; }

  broadcast(events) {
    const view = this.m.view();
    for (const s of this.seats) s.send({ t: 'ev', events, view });
    if (this.m.phase === PHASE.OVER) return this.end();
    // запас на анимации: бросок ~3 с, остальное короче
    const slack = Math.min(ANIM_MS, 1500 + events.reduce((t, e) => t + (e.type === 'roll' ? 3500 : e.type === 'zonk' ? 2500 : 1200), 0));
    this._schedule(slack);
  }

  _schedule(slack) {
    clearTimeout(this.timer);
    this.actionAt = Date.now() + slack;
    const cur = this.seats[this.m.current];
    const wait = slack + (cur.online ? TURN_MS + 4000 : OFFLINE_ACT_MS);
    this.timer = setTimeout(() => this._auto(), wait);
  }

  _auto() {
    if (this.m.phase === PHASE.OVER) return;
    const cur = this.seats[this.m.current];
    try { this.broadcast(this.m.timeout(cur.id)); } catch (e) { log('auto error', e.message); }
  }

  act(s, a, sel) {
    if (this.m.phase === PHASE.OVER) return;
    if (this.seats[this.m.current] !== s) return s.send({ t: 'err', msg: 'Сейчас не ваш ход' });
    const indices = Array.isArray(sel) ? sel.filter((i) => Number.isInteger(i) && i >= 0 && i < 6).slice(0, 6) : [];
    let events;
    try {
      events = a === 'bank' ? this.m.bank(s.id, indices)
        : a === 'roll' ? this.m.roll(s.id, indices)
          : a === 'timeout' ? (Date.now() - this.actionAt >= TURN_MS - 5000 ? this.m.timeout(s.id) : null)
            : null;
    } catch (e) { return s.send({ t: 'err', msg: e.message, view: this.m.view() }); }
    if (events) this.broadcast(events);
  }

  peek(s, sel) {
    if (this.seats[this.m.current] !== s || this.m.phase !== PHASE.SELECT) return;
    const indices = Array.isArray(sel) ? sel.filter((i) => Number.isInteger(i) && i >= 0 && i < 6).slice(0, 6) : [];
    this.other(s).send({ t: 'peek', sel: indices });
  }

  forfeit(s, why) {
    if (this.m.phase === PHASE.OVER) return;
    log(`forfeit ${s.name} (${why})`);
    this.broadcast(this.m.forfeit(s.id));
  }

  disconnected(s) {
    this.other(s).send({ t: 'opp', online: false });
    this.forfeitTimers.set(s, setTimeout(() => this.forfeit(s, 'offline'), FORFEIT_MS));
    if (this.seats[this.m.current] === s) this._schedule(Math.max(0, this.actionAt - Date.now()));
  }

  reconnected(s) {
    clearTimeout(this.forfeitTimers.get(s));
    this.forfeitTimers.delete(s);
    this.other(s).send({ t: 'opp', online: true });
    // вернулся во время своего хода — снова полный таймер (с запасом на перерисовку стола)
    if (this.seats[this.m.current] === s && this.m.phase !== PHASE.OVER) this._schedule(5000);
    const o = this.other(s);
    s.send({ t: 'resync', you: this.seatOf(s), mode: this.mode, stake: this.stake, view: this.m.view(), opp: { name: o.name, avatar: o.avatar, dice: o.dice } });
  }

  end() {
    clearTimeout(this.timer);
    for (const t of this.forfeitTimers.values()) clearTimeout(t);
    games.delete(this);
    for (const s of this.seats) if (s.game === this) s.game = null;
    log(`end ${this.seats.map((s) => s.name).join(' vs ')} → ${this.seats[this.m.winner]?.name}`);
  }
}

// ── очередь и комнаты ─────────────────────────────────────
function dequeue(s) {
  if (!s.queued) return;
  const q = queues.get(s.queued);
  const i = q.indexOf(s);
  if (i >= 0) q.splice(i, 1);
  s.queued = 0;
}
function closeRoom(s) {
  if (s.room && rooms.get(s.room) === s) rooms.delete(s.room);
  s.room = null;
}
function makeCode() {
  for (;;) {
    const c = Array.from({ length: 4 }, () => ALPH[randomInt(ALPH.length)]).join('');
    if (!rooms.has(c)) return c;
  }
}

// ── сообщения ─────────────────────────────────────────────
function handle(sock, state, m) {
  if (m.t === 'hello') {
    const token = clean(m.token, 64);
    if (token.length < 8) return sock.close(1008);
    let s = sessions.get(token);
    if (!s) { s = new Session(token); sessions.set(token, s); }
    if (s.sock && s.sock !== sock) { s.sock.removeAllListeners('close'); s.sock.close(4000); }
    s.sock = sock; s.online = true; s.seen = Date.now();
    s.name = clean(m.name, 16) || 'Игрок';
    s.avatar = /^av_[a-z]+$/.test(m.avatar || '') ? m.avatar : null;
    s.dice = /^[a-z0-9_]{1,24}$/.test(m.dice || '') ? m.dice : 'classic';
    state.s = s;
    sock.send({ t: 'welcome', id: s.id, online: onlineCount(), v: VERSION });
    if (s.game) s.game.reconnected(s);
    return;
  }
  const s = state.s;
  if (!s) return;
  s.seen = Date.now();
  switch (m.t) {
    case 'ping': return s.send({ t: 'pong', online: onlineCount() });
    case 'queue': {
      const stake = Number(m.stake);
      if (!STAKES.includes(stake)) return s.send({ t: 'err', msg: 'Нет такой комнаты' });
      if (s.game) return s.send({ t: 'err', msg: 'Вы уже за столом' });
      dequeue(s); closeRoom(s);
      const q = queues.get(stake);
      const opp = q.find((o) => o !== s && o.online);
      if (opp) return new Game(opp, s, 'stake', stake);
      q.push(s); s.queued = stake;
      return s.send({ t: 'queued', stake });
    }
    case 'unqueue': dequeue(s); return s.send({ t: 'unqueued' });
    case 'room_create': {
      if (s.game) return s.send({ t: 'err', msg: 'Вы уже за столом' });
      dequeue(s); closeRoom(s);
      s.room = makeCode(); rooms.set(s.room, s);
      return s.send({ t: 'room', code: s.room });
    }
    case 'room_join': {
      const code = clean(m.code, 4).toUpperCase();
      const host = rooms.get(code);
      if (!host || !host.online) return s.send({ t: 'room_err', msg: `Комната ${code} не найдена` });
      if (host === s) return s.send({ t: 'room_err', msg: 'Это ваша собственная комната' });
      if (s.game) return s.send({ t: 'room_err', msg: 'Вы уже за столом' });
      return new Game(host, s, 'friend', 0);
    }
    case 'room_close': closeRoom(s); return;
    case 'act': return s.game?.act(s, m.a, m.sel);
    case 'peek': return s.game?.peek(s, m.sel);
    case 'leave': return s.game?.forfeit(s, 'leave');
    default:
  }
}

// ── HTTP + WebSocket ──────────────────────────────────────
const pub = join(root, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, online: onlineCount(), games: games.size, v: VERSION }));
  }
  if ((url === '/' || url === '/index.html') && existsSync(pub)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': statSync(pub).size, 'cache-control': 'no-cache' });
    return res.end(readFileSync(pub));
  }
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Зонк: сервер работает');
  }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, sock) => {
  const ws = accept(req, sock);
  if (!ws) return;
  const state = { s: null, n: 0, t0: Date.now() };
  ws.on('message', (m) => {
    // простая защита от флуда: не больше 40 сообщений в секунду
    const now = Date.now();
    if (now - state.t0 > 1000) { state.t0 = now; state.n = 0; }
    if (++state.n > 40) return ws.close(1008);
    try { handle(ws, state, m); } catch (e) { log('handler error', e); }
  });
  ws.on('close', () => {
    const s = state.s;
    if (!s || s.sock !== ws) return;
    s.online = false; s.seen = Date.now();
    dequeue(s); closeRoom(s);
    s.game?.disconnected(s);
  });
});

setInterval(() => {
  for (const s of sessions.values()) if (s.online) s.sock.ping();
  const now = Date.now();
  for (const [k, s] of sessions) if (!s.online && !s.game && now - s.seen > SESSION_TTL) sessions.delete(k);
}, 25_000);

server.listen(PORT, () => log(`Зонк-сервер слушает порт ${PORT}`));
