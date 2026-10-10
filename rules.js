// ─────────────────────────────────────────────────────────────
//  ЗОНК — правила подсчёта очков (классика).
//  Источник: bestcasinos.ru/blog/kombinacii-i-pravila-igry-v-zonk
//  Чистый модуль без зависимостей: используется и клиентом,
//  и будущим Node.js сервером (серверная проверка ходов).
// ─────────────────────────────────────────────────────────────

export const RULES = {
  target: 10000,       // классическая партия — до 10 000
  dice: 6,
  single: { 1: 100, 5: 50 },
  triple: (f) => (f === 1 ? 1000 : f * 100),
  four: 1000,
  five: 2000,
  six: 3000,
  straight: 1500,      // 1-2-3-4-5-6
  threePairs: 750,
  twoTriples: 2500,
};

export function counts(values) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const v of values) c[v]++;
  return c;
}

/** Все комбинации, которые можно «вынуть» из набора counts. */
function combosFor(c) {
  const total = c.reduce((a, b) => a + b, 0);
  const out = [];
  if (total === 6) {
    if (c.slice(1).every((n) => n === 1)) out.push({ name: 'Стрит', use: [0, 1, 1, 1, 1, 1, 1], points: RULES.straight });
    const triples = c.filter((n) => n === 3).length;
    if (triples === 2) out.push({ name: 'Две тройки', use: c.slice(), points: RULES.twoTriples });
    let pairs = 0, ok = true;
    for (let f = 1; f <= 6; f++) { if (c[f] === 2) pairs++; else if (c[f] === 4) pairs += 2; else if (c[f]) ok = false; }
    if (ok && pairs === 3) out.push({ name: 'Три пары', use: c.slice(), points: RULES.threePairs });
  }
  for (let f = 1; f <= 6; f++) {
    const n = c[f];
    const use = (k) => { const u = [0, 0, 0, 0, 0, 0, 0]; u[f] = k; return u; };
    if (n >= 6) out.push({ name: `Шесть «${f}»`, use: use(6), points: RULES.six });
    if (n >= 5) out.push({ name: `Пять «${f}»`, use: use(5), points: RULES.five });
    if (n >= 4) out.push({ name: `Четыре «${f}»`, use: use(4), points: RULES.four });
    if (n >= 3) out.push({ name: `Три «${f}»`, use: use(3), points: RULES.triple(f) });
    if (n >= 1 && RULES.single[f]) out.push({ name: f === 1 ? 'Единица' : 'Пятёрка', use: use(1), points: RULES.single[f] });
  }
  return out;
}

const memo = new Map();
/** Лучшее разбиение ВСЕХ кубиков на комбинации; -Infinity если какой-то кубик лишний. */
function bestPartition(c) {
  const key = c.join('');
  if (memo.has(key)) return memo.get(key);
  let res;
  if (c.every((n) => n === 0)) res = { score: 0, combos: [] };
  else {
    res = { score: -Infinity, combos: [] };
    for (const cb of combosFor(c)) {
      const rest = c.map((n, i) => n - cb.use[i]);
      const sub = bestPartition(rest);
      if (sub.score === -Infinity) continue;
      const s = cb.points + sub.score;
      if (s > res.score) {
        const dice = [];
        cb.use.forEach((k, f) => { for (let i = 0; i < k; i++) dice.push(f); });
        res = { score: s, combos: [{ name: cb.name, dice, points: cb.points }, ...sub.combos] };
      }
    }
  }
  memo.set(key, res);
  return res;
}

/**
 * Оценка ВЫБРАННЫХ кубиков: все кубики должны участвовать в комбинациях.
 * @returns {{score:number, valid:boolean, combos:{name:string, dice:number[], points:number}[]}}
 */
export function scoreSelection(values) {
  if (!values.length) return { score: 0, valid: false, combos: [] };
  const r = bestPartition(counts(values));
  if (r.score === -Infinity) return { score: 0, valid: false, combos: [] };
  return { score: r.score, valid: true, combos: r.combos };
}

/** Все очковые варианты выбора из броска (подмножества), по убыванию очков. */
export function scoringOptions(values) {
  const n = values.length, out = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const idx = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    const r = scoreSelection(idx.map((i) => values[i]));
    if (r.valid) out.push({ score: r.score, indices: idx });
  }
  return out.sort((a, b) => b.score - a.score || b.indices.length - a.indices.length);
}

/** Лучший возможный выбор из броска. */
export function bestSelection(values) {
  return scoringOptions(values)[0] || { score: 0, indices: [] };
}

export const hasScore = (values) => values.some((v) => v === 1 || v === 5) || counts(values).some((n) => n >= 3) || scoringOptions(values).length > 0;

/** Таблица комбинаций для экрана «Комбинации». */
export const COMBO_TABLE = [
  { name: 'Единица', dice: [1], points: 100 },
  { name: 'Пятёрка', dice: [5], points: 50 },
  { name: 'Три единицы', dice: [1, 1, 1], points: 1000 },
  { name: 'Три двойки', dice: [2, 2, 2], points: 200 },
  { name: 'Три тройки', dice: [3, 3, 3], points: 300 },
  { name: 'Три четвёрки', dice: [4, 4, 4], points: 400 },
  { name: 'Три пятёрки', dice: [5, 5, 5], points: 500 },
  { name: 'Три шестёрки', dice: [6, 6, 6], points: 600 },
  { name: 'Четыре одинаковых', dice: [3, 3, 3, 3], points: 1000 },
  { name: 'Пять одинаковых', dice: [3, 3, 3, 3, 3], points: 2000 },
  { name: 'Шесть одинаковых', dice: [3, 3, 3, 3, 3, 3], points: 3000 },
  { name: 'Три пары', dice: [2, 2, 4, 4, 6, 6], points: 750 },
  { name: 'Стрит', dice: [1, 2, 3, 4, 5, 6], points: 1500 },
  { name: 'Две тройки', dice: [2, 2, 2, 6, 6, 6], points: 2500 },
];
