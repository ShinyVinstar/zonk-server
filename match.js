// ─────────────────────────────────────────────────────────────
//  ЗОНК — состояние партии (авторитетная логика).
//  На клиенте сейчас крутится локально (игра с ботом),
//  на следующем этапе этот же класс будет жить на Node.js сервере,
//  а клиент получит те же события по WebSocket.
// ─────────────────────────────────────────────────────────────
import { RULES, scoreSelection, bestSelection, hasScore } from './rules.js';

export const PHASE = { AWAIT_ROLL: 'await_roll', SELECT: 'select', OVER: 'over' };

const defaultRng = () => Math.random();
const d6 = (rng) => 1 + Math.floor(rng() * 6);

export class ZonkMatch {
  /**
   * @param {{players:{id:string,name:string,avatar?:string}[], target?:number, rng?:()=>number, firstPlayer?:number}} o
   */
  constructor(o) {
    this.rng = o.rng || defaultRng;
    this.target = o.target || RULES.target;
    this.players = o.players.map((p) => ({ ...p, score: 0, rounds: [] }));
    this.starter = o.firstPlayer ?? Math.floor(this.rng() * this.players.length);
    this.current = this.starter;
    this.round = 1;
    this.phase = PHASE.AWAIT_ROLL;
    this.winner = null;
    this._resetTurn();
  }

  _resetTurn() {
    this.turn = { points: 0, diceLeft: RULES.dice, roll: null, kept: [] };
  }

  get currentPlayer() { return this.players[this.current]; }

  /** Снимок для отправки клиенту. */
  view() {
    return {
      target: this.target, round: this.round, current: this.current, phase: this.phase, winner: this.winner,
      players: this.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, rounds: [...p.rounds] })),
      turn: { ...this.turn, roll: this.turn.roll && [...this.turn.roll], kept: [...this.turn.kept] },
    };
  }

  _assertTurn(playerId) {
    if (this.phase === PHASE.OVER) throw new Error('Партия окончена');
    if (this.currentPlayer.id !== playerId) throw new Error('Сейчас не ваш ход');
  }

  /** Проверка выбора без применения (для подсказок UI). */
  evaluate(indices) {
    const roll = this.turn.roll || [];
    const uniq = [...new Set(indices)].filter((i) => i >= 0 && i < roll.length);
    return scoreSelection(uniq.map((i) => roll[i]));
  }

  _commitSelection(indices, events) {
    const roll = this.turn.roll;
    const uniq = [...new Set(indices)];
    const values = uniq.map((i) => roll[i]);
    const res = scoreSelection(values);
    if (!res.valid || res.score <= 0) throw new Error('Выбраны кубики без комбинации');
    this.turn.points += res.score;
    this.turn.kept.push(...values);
    this.turn.diceLeft -= values.length;
    events.push({ type: 'select', player: this.current, indices: uniq, values, points: res.score, turnPoints: this.turn.points, combos: res.combos });
  }

  /** Бросок. На первом броске selection пустой; дальше — обязателен выбор из предыдущего броска. */
  roll(playerId, selection = []) {
    this._assertTurn(playerId);
    const events = [];
    if (this.phase === PHASE.SELECT) {
      this._commitSelection(selection, events);
    } else if (this.phase !== PHASE.AWAIT_ROLL) {
      throw new Error('Сейчас нельзя бросать');
    }
    let hot = false;
    if (this.turn.diceLeft === 0) { // все кубики сыграли — «горячие кубики»
      hot = true;
      this.turn.diceLeft = RULES.dice;
      this.turn.kept = [];
    }
    const values = Array.from({ length: this.turn.diceLeft }, () => d6(this.rng));
    this.turn.roll = values;
    events.push({ type: 'roll', player: this.current, values, hot, turnPoints: this.turn.points });

    if (!hasScore(values)) {
      const lost = this.turn.points;
      events.push({ type: 'zonk', player: this.current, lost });
      this.currentPlayer.rounds.push({ points: 0, zonk: true });
      this._endTurn(events);
    } else {
      this.phase = PHASE.SELECT;
    }
    return events;
  }

  /** Забрать очки: выбранные кубики + накопленное за ход. */
  bank(playerId, selection = []) {
    this._assertTurn(playerId);
    if (this.phase !== PHASE.SELECT) throw new Error('Сначала бросьте кубики');
    const events = [];
    this._commitSelection(selection, events);
    const p = this.currentPlayer;
    p.score += this.turn.points;
    p.rounds.push({ points: this.turn.points, zonk: false });
    events.push({ type: 'bank', player: this.current, points: this.turn.points, total: p.score });
    this._endTurn(events);
    return events;
  }

  /** Истекло время хода — сервер делает ход за игрока. */
  timeout(playerId) {
    this._assertTurn(playerId);
    if (this.phase === PHASE.AWAIT_ROLL) return this.roll(playerId, []);
    const best = bestSelection(this.turn.roll);
    return this.bank(playerId, best.indices);
  }

  /** Игрок покинул стол (или не вернулся после обрыва связи) — победа сопернику. */
  forfeit(playerId) {
    if (this.phase === PHASE.OVER) return [];
    const loser = this.players.findIndex((p) => p.id === playerId);
    if (loser < 0) return [];
    this.phase = PHASE.OVER;
    this.winner = loser === 0 ? 1 : 0;
    return [{ type: 'over', winner: this.winner, scores: this.players.map((p) => p.score), forfeit: loser }];
  }

  _endTurn(events) {
    this._resetTurn();
    const next = (this.current + 1) % this.players.length;
    // Партия завершается только в конце полного круга — у всех одинаковое число ходов.
    if (next === this.starter) {
      const top = Math.max(...this.players.map((p) => p.score));
      const leaders = this.players.filter((p) => p.score === top);
      if (top >= this.target && leaders.length === 1) {
        this.phase = PHASE.OVER;
        this.winner = this.players.indexOf(leaders[0]);
        events.push({ type: 'over', winner: this.winner, scores: this.players.map((p) => p.score) });
        return;
      }
      this.round += 1;
    }
    this.current = next;
    this.phase = PHASE.AWAIT_ROLL;
    events.push({ type: 'turn', player: this.current, round: this.round });
  }
}
