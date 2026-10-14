import { addDays, diffDays } from './dates.js';

// 司機與車輛統計：每位司機跑了幾趟、哪幾天／星期幾車最滿、司機出勤率，幫助排班與判斷要不要加車。
// 依用車日計算，取消的訂單不計。

const PAID = new Set(['paid', 'shipped', 'completed']);
const WEEKDAY = '日一二三四五六';

export function buildDriverStats(store, { from, to, brandIds = null }) {
  if (from > to) [from, to] = [to, from];
  const ids = brandIds?.length ? brandIds : null;
  const trips = store.all(
    `SELECT o.id, o.service_date, o.amount, o.status, o.driver_id,
            COALESCE(o.driver_name_snap, d.name) AS driver_name, COALESCE(o.driver_plate_snap, d.plate) AS plate, COALESCE(o.driver_car_snap, d.car_model) AS car_model
     FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN drivers d ON d.id = o.driver_id
     WHERE o.status != 'cancelled' AND o.service_date BETWEEN ? AND ?${ids ? ` AND c.brand_id IN (${ids.map(() => '?').join(',')})` : ''}`,
    from, to, ...(ids || []),
  );
  const activeDrivers = store.get('SELECT COUNT(*) AS n FROM drivers WHERE active = 1').n;
  const days = diffDays(to, from) + 1;

  const drivers = new Map();
  for (const t of trips.filter((x) => x.driver_id)) {
    const key = t.driver_id;
    if (!drivers.has(key)) drivers.set(key, { driver_id: key, name: t.driver_name, plate: t.plate, car_model: t.car_model, trips: 0, revenue: 0, dates: new Set() });
    const d = drivers.get(key);
    d.trips++;
    if (PAID.has(t.status)) d.revenue += t.amount;
    d.dates.add(t.service_date);
  }
  const byDriver = [...drivers.values()].map(({ dates, ...d }) => ({ ...d, days: dates.size, perDay: dates.size ? Math.round((d.trips / dates.size) * 10) / 10 : 0 }))
    .sort((a, b) => b.trips - a.trips);

  // 每一天：幾趟、用了幾位司機
  const perDate = new Map();
  for (const t of trips) {
    if (!perDate.has(t.service_date)) perDate.set(t.service_date, { date: t.service_date, trips: 0, unassigned: 0, drivers: new Set() });
    const p = perDate.get(t.service_date);
    p.trips++;
    if (t.driver_id) p.drivers.add(t.driver_id);
    else p.unassigned++;
  }
  const dates = [...perDate.values()].map(({ drivers: ds, ...p }) => ({ ...p, drivers: ds.size, weekday: WEEKDAY[new Date(`${p.date}T00:00:00Z`).getUTCDay()] }));
  const busiestDays = [...dates].sort((a, b) => b.trips - a.trips || (a.date < b.date ? -1 : 1)).slice(0, 7);

  // 星期幾平均幾趟（以期間內出現幾次該星期計算）
  const weekdays = Array.from({ length: 7 }, (_, i) => ({ day: WEEKDAY[i], trips: 0, occurrences: 0 }));
  for (let d = from; d <= to; d = addDays(d, 1)) weekdays[new Date(`${d}T00:00:00Z`).getUTCDay()].occurrences++;
  for (const t of trips) weekdays[new Date(`${t.service_date}T00:00:00Z`).getUTCDay()].trips++;
  for (const w of weekdays) w.avg = w.occurrences ? Math.round((w.trips / w.occurrences) * 10) / 10 : 0;
  const weekOrder = [...weekdays.slice(1), weekdays[0]]; // 一～日

  const workingDates = dates.filter((d) => d.drivers);
  const totals = {
    trips: trips.length,
    assigned: trips.filter((t) => t.driver_id).length,
    unassigned: trips.filter((t) => !t.driver_id).length,
    activeDrivers,
    days,
    avgTripsPerDay: Math.round((trips.length / days) * 10) / 10,
    // 有行程的日子平均用到幾成的司機
    utilization: activeDrivers && workingDates.length ? workingDates.reduce((s, d) => s + d.drivers, 0) / workingDates.length / activeDrivers : null,
  };

  const insights = [];
  if (!trips.length) insights.push('這段期間沒有行程。');
  else {
    const top = weekdays.reduce((a, b) => (b.avg > a.avg ? b : a));
    const low = weekdays.filter((w) => w.occurrences).reduce((a, b) => (b.avg < a.avg ? b : a));
    if (top.avg > 0) insights.push(`星期${top.day}最忙，平均每天 ${top.avg} 趟${low.day !== top.day ? `；星期${low.day}最空（${low.avg} 趟），可安排司機休假或保養車輛` : ''}。`);
    if (activeDrivers) {
      const full = dates.filter((d) => d.trips > activeDrivers);
      if (full.length) insights.push(`有 ${full.length} 天的行程數超過在職司機人數（${activeDrivers} 位），例如 ${full.slice(0, 3).map((d) => `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}（${d.weekday}）${d.trips} 趟`).join('、')}，如果常發生，可考慮增加合作司機或車輛。`);
      if (totals.utilization != null && totals.utilization < 0.4 && totals.trips >= 10) insights.push(`有行程的日子平均只用到 ${Math.round(totals.utilization * 100)}% 的司機，人力偏多，可以把行程集中排給固定司機。`);
    }
    if (totals.unassigned) insights.push(`有 ${totals.unassigned} 趟行程沒有指派司機紀錄，請在訂單上指派，統計才會準確。`);
    if (byDriver.length >= 2) {
      const [first] = byDriver;
      const share = first.trips / totals.assigned;
      if (share >= 0.5 && totals.assigned >= 10) insights.push(`${first.name} 一個人跑了 ${Math.round(share * 100)}% 的行程，工作量集中，注意司機疲勞與請假時的人力備援。`);
    }
  }

  return { from, to, totals, byDriver, busiestDays, weekdays: weekOrder, insights };
}
