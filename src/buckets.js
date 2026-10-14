import { addDays, diffDays } from './dates.js';

// 把日期切成「日／週／月」區間，報表的趨勢與明細共用。週從星期一開始。

export const GRANULARITIES = { day: '日', week: '週', month: '月' };
const WEEKDAY = '日一二三四五六';

const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const monday = (d) => addDays(d, -((weekday(d) + 6) % 7));

// 期間太長時自動改用較粗的單位
export function autoGranularity(from, to) {
  const days = diffDays(to, from) + 1;
  return days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
}

export function bucketKey(date, granularity) {
  if (granularity === 'day') return date;
  if (granularity === 'week') return monday(date);
  return date.slice(0, 7);
}

export function listBuckets(from, to, granularity) {
  const out = [];
  if (granularity === 'month') {
    let [y, m] = from.split('-').map(Number);
    const end = to.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      out.push({ key, label: key, from: `${key}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) });
      if (key >= end) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  const step = granularity === 'week' ? 7 : 1;
  for (let d = bucketKey(from, granularity); d <= to; d = addDays(d, step)) {
    const last = addDays(d, step - 1);
    out.push({
      key: d,
      label: granularity === 'week' ? `${md(d)}–${md(last)}` : `${md(d)}（${WEEKDAY[weekday(d)]}）`,
      from: d,
      to: last,
    });
  }
  return out;
}

export function resolveGranularity(value, from, to) {
  const g = GRANULARITIES[value] ? value : autoGranularity(from, to);
  const count = listBuckets(from, to, g).length;
  if (count > 400) throw new Error('區間太多，請改用較粗的單位（週或月）或縮短期間');
  return g;
}
