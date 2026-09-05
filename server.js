require('dotenv').config();
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json({ limit: '45mb' }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // токен бота для курьеров (из BotFather)
const OWNER_TELEGRAM_CHAT_ID = process.env.OWNER_TELEGRAM_CHAT_ID; // chat_id владельца — получает ежедневную сводку по "мёртвому" товару и спящим клиентам
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR || 9); // час отправки сводки (0-23, по времени сервера — задайте TZ=Asia/Dushanbe в Railway)

if (!JWT_SECRET || !ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) {
  console.warn(
    '⚠️  Не заданы JWT_SECRET / ADMIN_EMAIL / ADMIN_PASSWORD_HASH — ' +
    'вход в admin.html и защита API работать не будут. См. README-DATABASE.md.'
  );
}

// ----------------------------------------------------------------------------
// подключение к MySQL — Railway сам создаёт переменную MYSQL_URL, если её нет,
// используем отдельные MYSQLHOST/MYSQLUSER/... (тоже задаются Railway)
// ----------------------------------------------------------------------------
const pool = process.env.MYSQL_URL
  ? mysql.createPool(process.env.MYSQL_URL)
  : mysql.createPool({
      host: process.env.MYSQLHOST,
      port: process.env.MYSQLPORT,
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
    });

// ----------------------------------------------------------------------------
// проверка JWT-токена администратора
// ----------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

// ----------------------------------------------------------------------------
// публичный эндпоинт: создать заказ (вызывается из index.html)
// ----------------------------------------------------------------------------
// учёт посещения сайта (вызывается с главной страницы один раз за сессию)
app.post('/api/track-visit', async (req, res) => {
  try {
    const { visitor_id, utm_source } = req.body || {};
    await pool.query('INSERT INTO site_visits (created_at, visitor_id, utm_source) VALUES (NOW(), ?, ?)', [visitor_id || null, utm_source || null]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false }); // не мешаем сайту работать, если это не удалось
  }
});

app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_phone, customer_address, comment, items, total, channel, promo_code, utm_source, utm_medium, utm_campaign } = req.body || {};

  if (!customer_name || !customer_phone || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Не хватает обязательных полей заказа' });
  }

  try {
    let finalTotal = Number(total) || 0;
    let discountAmount = null;
    let usedCode = null;

    if (promo_code) {
      const [[promo]] = await pool.query('SELECT * FROM promo_codes WHERE code = ? AND active = 1', [promo_code.trim().toUpperCase()]);
      if (promo && (!promo.expires_at || new Date(promo.expires_at) >= new Date())) {
        if (promo.usage_limit == null || await promoUsageCount(promo.id) < promo.usage_limit) {
          discountAmount = promo.discount_type === 'percent'
            ? round2(finalTotal * Number(promo.discount_value) / 100)
            : round2(Number(promo.discount_value));
          discountAmount = Math.min(discountAmount, finalTotal);
          finalTotal = round2(finalTotal - discountAmount);
          usedCode = promo.code;
        }
      }
    }

    const [result] = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, customer_address, comment, items, total, status, channel, promo_code, discount_amount, utm_source, utm_medium, utm_campaign)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
      [customer_name, customer_phone, customer_address || null, comment || null, JSON.stringify(items), finalTotal, channel || null, usedCode, discountAmount, utm_source || null, utm_medium || null, utm_campaign || null]
    );
    res.json({ id: result.insertId, total: finalTotal, discount_amount: discountAmount });
  } catch (e) {
    console.error('Ошибка создания заказа:', e);
    res.status(500).json({ error: 'Не удалось сохранить заказ' });
  }
});

async function promoUsageCount(promoId) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM orders WHERE promo_code = (SELECT code FROM promo_codes WHERE id = ?)',
    [promoId]
  );
  return Number(row.cnt) || 0;
}

// ----------------------------------------------------------------------------
// вход администратора — email + пароль → JWT-токен на 7 дней
// ----------------------------------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) {
    return res.status(500).json({ error: 'Администратор не настроен на сервере' });
  }
  if (email !== ADMIN_EMAIL) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const ok = await bcrypt.compare(password || '', ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ----------------------------------------------------------------------------
// список заказов — только для вошедшего администратора
// ----------------------------------------------------------------------------
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT o.*,
        CASE WHEN c.id IS NOT NULL THEN TRIM(CONCAT(c.first_name, ' ', COALESCE(c.last_name,''))) ELSE NULL END AS courier_name,
        c.phone AS courier_phone
      FROM orders o
      LEFT JOIN couriers c ON c.id = o.courier_id
      ORDER BY o.created_at DESC
    `);
    const orders = rows.map(r => ({
      ...r,
      items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
    }));
    res.json(orders);
  } catch (e) {
    console.error('Ошибка получения заказов:', e);
    res.status(500).json({ error: 'Не удалось получить заказы' });
  }
});

// ----------------------------------------------------------------------------
// смена статуса заказа — только для вошедшего администратора
// ----------------------------------------------------------------------------
const ALLOWED_STATUSES = ['new', 'progress', 'done', 'cancel'];

app.patch('/api/orders/:id', requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }
  try {
    // если админ вручную закрывает заказ как "Выполнен" и на нём назначен курьер —
    // одновременно проставляем delivery_status='delivered', иначе зарплата курьеру
    // и расход в Финансах не посчитаются (они смотрят именно на delivery_status,
    // а не на общий статус заказа — раньше эти два поля не были синхронизированы)
    if (status === 'done') {
      await pool.query(
        "UPDATE orders SET status = ?, delivery_status = IF(courier_id IS NOT NULL, 'delivered', delivery_status), completed_at = NOW() WHERE id = ?",
        [status, req.params.id]
      );
    } else {
      await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    }
    res.json({ ok: true });

    // при переводе в обработку — рассылаем заказ курьерам в Telegram (если ещё не отправляли)
    if (status === 'progress') {
      const [[order]] = await pool.query('SELECT delivery_status FROM orders WHERE id = ?', [req.params.id]);
      if (order && order.delivery_status === 'waiting') {
        broadcastOrderToCouriers(req.params.id).catch(e => console.error('Ошибка рассылки курьерам:', e));
      }
    }
  } catch (e) {
    console.error('Ошибка обновления статуса:', e);
    res.status(500).json({ error: 'Не удалось обновить статус' });
  }
});

// --- возврат по заказу ---
// Возврат уменьшает "эффективную" сумму заказа (orders.refunded_amount), а не удаляет сам заказ.
// Везде, где считается выручка/себестоимость/комиссия партнёру — используется (total - refunded_amount)
// вместо total, поэтому возврат автоматически и корректно пересчитывает всю цепочку без двойного учёта.
app.post('/api/orders/:id/refund', requireAuth, async (req, res) => {
  const { amount, reason } = req.body || {};
  try {
    const [[order]] = await pool.query('SELECT total, refunded_amount FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    const already = Number(order.refunded_amount) || 0;
    const maxRefundable = Number(order.total) - already;
    const refundAmount = amount != null ? Number(amount) : maxRefundable; // без суммы — считаем возврат полным
    if (refundAmount <= 0 || refundAmount > maxRefundable + 0.01) {
      return res.status(400).json({ error: `Сумма возврата должна быть от 0 до ${round2(maxRefundable)} смн` });
    }
    await pool.query('INSERT INTO refunds (order_id, amount, reason) VALUES (?, ?, ?)', [req.params.id, refundAmount, reason || null]);
    await pool.query('UPDATE orders SET refunded_amount = refunded_amount + ? WHERE id = ?', [refundAmount, req.params.id]);
    res.json({ ok: true, refunded_amount: round2(already + refundAmount) });
  } catch (e) {
    console.error('Ошибка оформления возврата:', e);
    res.status(500).json({ error: 'Не удалось оформить возврат' });
  }
});

app.get('/api/orders/:id/refunds', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Не удалось получить возвраты' });
  }
});

// ручное назначение курьера на заказ (админ выбирает сам, без рассылки всем)
app.post('/api/orders/:id/assign-courier', requireAuth, async (req, res) => {
  const { courier_id } = req.body || {};
  try {
    const [[courier]] = await pool.query('SELECT * FROM couriers WHERE id = ?', [courier_id]);
    if (!courier) return res.status(404).json({ error: 'Курьер не найден' });

    // если заказ уже отмечен как "Выполнен" (например, курьера назначили постфактум),
    // сразу считаем доставку завершённой — иначе она выпадет из расчёта зарплаты/Финансов
    const [[orderNow]] = await pool.query('SELECT status FROM orders WHERE id = ?', [req.params.id]);
    const newDeliveryStatus = orderNow && orderNow.status === 'done' ? 'delivered' : 'in_transit';
    await pool.query('UPDATE orders SET courier_id = ?, delivery_status = ? WHERE id = ?', [courier_id, newDeliveryStatus, req.params.id]);
    res.json({ ok: true });

    if (courier.telegram_chat_id && newDeliveryStatus !== 'delivered') {
      const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
      const text = buildOrderMessage(order, '👤 Ин фармоиш ба шумо аз ҷониби администратор дода шуд.');
      tgCall('sendMessage', {
        chat_id: courier.telegram_chat_id, text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📦 Расонида шуд (доставлено)', callback_data: `delivered_${req.params.id}` }]] },
      }).catch(e => console.error('Ошибка отправки курьеру:', e));
    }
  } catch (e) {
    console.error('Ошибка назначения курьера:', e);
    res.status(500).json({ error: 'Не удалось назначить курьера' });
  }
});

// ----------------------------------------------------------------------------
// КАДРЫ — сотрудники, опоздания, контракты, отпуска, авансы, ОС (техника)
// ----------------------------------------------------------------------------
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, first_name, last_name, middle_name, photo, position, department, active FROM employees ORDER BY active DESC, created_at DESC');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка получения сотрудников:', e);
    res.status(500).json({ error: 'Не удалось получить сотрудников' });
  }
});

app.get('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const [[emp]] = await pool.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Сотрудник не найден' });
    const [contacts] = await pool.query('SELECT * FROM employee_contacts WHERE employee_id = ?', [req.params.id]);
    const [lateness] = await pool.query('SELECT * FROM employee_lateness WHERE employee_id = ? ORDER BY date DESC', [req.params.id]);
    const [contracts] = await pool.query('SELECT * FROM employee_contracts WHERE employee_id = ? ORDER BY start_date DESC', [req.params.id]);
    const [vacations] = await pool.query('SELECT * FROM employee_vacations WHERE employee_id = ? ORDER BY start_date DESC', [req.params.id]);
    const [advances] = await pool.query('SELECT * FROM employee_advances WHERE employee_id = ? ORDER BY date DESC', [req.params.id]);
    const [assets] = await pool.query('SELECT * FROM employee_assets WHERE employee_id = ? ORDER BY issue_date DESC', [req.params.id]);
    res.json({ ...emp, contacts, lateness, contracts, vacations, advances, assets });
  } catch (e) {
    console.error('Ошибка получения сотрудника:', e);
    res.status(500).json({ error: 'Не удалось получить сотрудника' });
  }
});

app.post('/api/employees', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.first_name) return res.status(400).json({ error: 'Укажите имя' });
  try {
    const [result] = await pool.query(
      `INSERT INTO employees (first_name, last_name, middle_name, photo, position, department, birth_date, email, phone, passport_series, social_insurance_number, inn, hire_date, notes, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [b.first_name, b.last_name||null, b.middle_name||null, b.photo||null, b.position||null, b.department||null,
       b.birth_date||null, b.email||null, b.phone||null, b.passport_series||null, b.social_insurance_number||null,
       b.inn||null, b.hire_date||null, b.notes||null]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка добавления сотрудника:', e);
    res.status(500).json({ error: 'Не удалось добавить сотрудника' });
  }
});

app.patch('/api/employees/:id', requireAuth, async (req, res) => {
  const allowed = ['first_name','last_name','middle_name','photo','position','department','birth_date','email','phone','passport_series','social_insurance_number','inn','hire_date','notes','active'];
  const body = req.body || {};
  const sets = []; const values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) { sets.push(`${key} = ?`); values.push(key==='active' ? (body[key]?1:0) : body[key]); }
  }
  if (!sets.length) return res.json({ ok: true });
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка изменения сотрудника:', e);
    res.status(500).json({ error: 'Не удалось изменить сотрудника' });
  }
});

app.delete('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    for (const t of ['employee_contacts','employee_lateness','employee_contracts','employee_vacations','employee_advances','employee_assets']) {
      await pool.query(`DELETE FROM ${t} WHERE employee_id = ?`, [id]);
    }
    await pool.query('DELETE FROM employees WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления сотрудника:', e);
    res.status(500).json({ error: 'Не удалось удалить сотрудника' });
  }
});

// вспомогательный CRUD-конструктор для под-разделов сотрудника (опоздания/контракты/отпуска/авансы/ОС)
function makeEmployeeSubResource(app, path, table, fields) {
  app.post(`/api/employees/:id/${path}`, requireAuth, async (req, res) => {
    const b = req.body || {};
    const cols = ['employee_id', ...fields];
    const vals = [req.params.id, ...fields.map(f => b[f] ?? null)];
    try {
      await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`, vals);
      res.json({ ok: true });
    } catch (e) {
      console.error(`Ошибка добавления (${table}):`, e);
      res.status(500).json({ error: 'Не удалось сохранить' });
    }
  });
  app.delete(`/api/${path}/:itemId`, requireAuth, async (req, res) => {
    try {
      await pool.query(`DELETE FROM ${table} WHERE id = ?`, [req.params.itemId]);
      res.json({ ok: true });
    } catch (e) {
      console.error(`Ошибка удаления (${table}):`, e);
      res.status(500).json({ error: 'Не удалось удалить' });
    }
  });
}
makeEmployeeSubResource(app, 'contacts', 'employee_contacts', ['label','phone']);
makeEmployeeSubResource(app, 'lateness', 'employee_lateness', ['date','minutes','note']);
makeEmployeeSubResource(app, 'contracts', 'employee_contracts', ['title','start_date','end_date','note']);
makeEmployeeSubResource(app, 'vacations', 'employee_vacations', ['start_date','end_date','type','note']);
makeEmployeeSubResource(app, 'advances', 'employee_advances', ['date','amount','note']);
makeEmployeeSubResource(app, 'assets', 'employee_assets', ['item_name','serial_number','issue_date','return_date','note']);

// ----------------------------------------------------------------------------
// ДАШБОРД — большая сводка: выручка, трафик, график, клиенты, товары
// ----------------------------------------------------------------------------
function resolveDateRange(period, from, to) {
  const now = new Date();
  if (period === 'custom' && from && to) return { from, to };
  if (period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 6); return { from: d.toISOString().slice(0,10), to: now.toISOString().slice(0,10) }; }
  if (period === 'month') { const d = new Date(now); d.setDate(d.getDate() - 29); return { from: d.toISOString().slice(0,10), to: now.toISOString().slice(0,10) }; }
  // today
  const t = now.toISOString().slice(0,10);
  return { from: t, to: t };
}

app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
  const period = req.query.period || 'today';
  const { from, to } = resolveDateRange(period, req.query.from, req.query.to);

  try {
    // --- выручка / заказы / средний чек за период ---
    // считаем по дате ЗАВЕРШЕНИЯ заказа (completed_at), а не создания — иначе заказ,
    // оформленный вчера и доставленный сегодня, не попадёт в сегодняшний дашборд
    const [ordersInRange] = await pool.query(
      "SELECT * FROM orders WHERE status = 'done' AND DATE(COALESCE(completed_at, created_at)) BETWEEN ? AND ? ORDER BY COALESCE(completed_at, created_at) ASC",
      [from, to]
    );
    const revenue = ordersInRange.reduce((s,o) => {
      const total = Number(o.total)||0;
      const refunded = Number(o.refunded_amount)||0;
      return s + Math.max(0, total - refunded);
    }, 0);
    const ordersCount = ordersInRange.length;
    const avgCheck = ordersCount ? round2(revenue / ordersCount) : 0;

    // --- трафик и конверсия ---
    const [[visitRow]] = await pool.query('SELECT COUNT(*) AS cnt, COUNT(DISTINCT visitor_id) AS uniq FROM site_visits WHERE DATE(created_at) BETWEEN ? AND ?', [from, to]);
    const traffic = Number(visitRow.cnt) || 0;
    const uniqueVisitors = Number(visitRow.uniq) || 0;
    // конверсия считается от уникальных посетителей — точнее, чем от общего числа заходов
    const conversion = uniqueVisitors ? round2(ordersCount / uniqueVisitors * 100) : (traffic ? round2(ordersCount / traffic * 100) : 0);
    const [[visitYestRow]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM site_visits WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)'
    );
    const [[visitTodayRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM site_visits WHERE DATE(created_at) = CURDATE()');
    const trafficYesterday = Number(visitYestRow.cnt) || 0;
    const trafficToday = Number(visitTodayRow.cnt) || 0;
    const trafficDiff = trafficToday - trafficYesterday;
    const trafficDiffPct = trafficYesterday ? round2(trafficDiff / trafficYesterday * 100) : 0;

    // --- график продажи/расходы/прибыль по дням за период + 3 дня прогноза ---
    const [genExpAll] = await pool.query('SELECT expense_date, amount FROM general_expenses WHERE expense_date BETWEEN ? AND ?', [from, to]);
    const [purchAll] = await pool.query('SELECT purchase_date, qty, unit_price FROM purchases WHERE purchase_date BETWEEN ? AND ?', [from, to]);
    const dayMap = {};
    const addDay = (dateStr) => { if(!dayMap[dateStr]) dayMap[dateStr] = { sales:0, expenses:0 }; return dayMap[dateStr]; };
    for (const o of ordersInRange) {
      const key = new Date(o.completed_at || o.created_at).toISOString().slice(0,10);
      addDay(key).sales += Number(o.total) || 0;
    }
    for (const e of genExpAll) {
      const key = new Date(e.expense_date).toISOString().slice(0,10);
      addDay(key).expenses += Number(e.amount) || 0;
    }
    for (const p of purchAll) {
      const key = new Date(p.purchase_date).toISOString().slice(0,10);
      addDay(key).expenses += (Number(p.qty)||0) * (Number(p.unit_price)||0);
    }
    const dayKeys = Object.keys(dayMap).sort();
    const salesByDay = dayKeys.map(d => ({
      date: d, sales: round2(dayMap[d].sales), expenses: round2(dayMap[d].expenses),
      profit: round2(dayMap[d].sales - dayMap[d].expenses),
    }));
    // простой прогноз: среднее последних 3 дней, плоской линией на 3 дня вперёд (не ИИ, просто тренд)
    const last3 = salesByDay.slice(-3);
    const avgLast3 = last3.length ? last3.reduce((s,d)=>s+d.sales,0) / last3.length : 0;
    const prevAvg = salesByDay.length > 3 ? salesByDay.slice(-6,-3).reduce((s,d)=>s+d.sales,0) / Math.max(1, salesByDay.slice(-6,-3).length) : avgLast3;
    const forecastPct = prevAvg ? round2((avgLast3 - prevAvg) / prevAvg * 100) : 0;
    const forecast = [];
    if (dayKeys.length) {
      const lastDate = new Date(dayKeys[dayKeys.length-1]);
      for (let i=1;i<=3;i++){
        const d = new Date(lastDate); d.setDate(d.getDate()+i);
        forecast.push({ date: d.toISOString().slice(0,10), sales: round2(avgLast3) });
      }
    }

    // --- клиенты: за всё время (LTV, повторные, VIP, топ) ---
    const [allDoneOrders] = await pool.query("SELECT customer_name, customer_phone, total FROM orders WHERE status = 'done'");
    const custMap = {};
    for (const o of allDoneOrders) {
      const phone = (o.customer_phone||'').replace(/\D/g,'');
      if(!phone) continue;
      if(!custMap[phone]) custMap[phone] = { name: o.customer_name, phone, orders: 0, total: 0 };
      custMap[phone].orders += 1;
      custMap[phone].total += Number(o.total) || 0;
    }
    const custList = Object.values(custMap);
    const totalCustomers = custList.length;
    const repeatCustomers = custList.filter(c => c.orders > 1).length;
    const repeatRate = totalCustomers ? round2(repeatCustomers / totalCustomers * 100) : 0;
    const newRate = totalCustomers ? round2(100 - repeatRate) : 0;
    const totalRevenueAll = custList.reduce((s,c)=>s+c.total,0);
    const avgLtv = totalCustomers ? round2(totalRevenueAll / totalCustomers) : 0;
    const vipThreshold = avgLtv * 3;
    const vipCustomers = custList.filter(c => c.total >= vipThreshold && vipThreshold > 0).length;
    const topCustomers = [...custList].sort((a,b)=>b.total-a.total).slice(0,5).map(c => ({ name:c.name, orders:c.orders, total: round2(c.total) }));

    // --- товары: топ продаж / низкие продажи / всего / стоимость склада ---
    const [allProducts] = await pool.query('SELECT id, name_ru, price, cost_price, stock, views, active FROM products');
    const [allDoneOrdersForSales] = await pool.query("SELECT items FROM orders WHERE status = 'done'");
    const allTimeSalesById = {};
    for (const o of allDoneOrdersForSales) {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items||[]);
      for (const it of items) {
        allTimeSalesById[it.id] = (allTimeSalesById[it.id] || 0) + (Number(it.qty) || 0);
      }
    }
    const productStatsMap = {};
    allProducts.forEach(p => { productStatsMap[p.id] = { qty:0, revenue:0 }; });
    for (const o of ordersInRange) {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items||[]);
      for (const it of items) {
        if (productStatsMap[it.id]) {
          productStatsMap[it.id].qty += Number(it.qty)||0;
          productStatsMap[it.id].revenue += (Number(it.price)||0) * (Number(it.qty)||0);
        }
      }
    }
    const productsRanked = allProducts.map(p => ({
      id:p.id, name: p.name_ru, qty: productStatsMap[p.id].qty, revenue: round2(productStatsMap[p.id].revenue),
      stock: p.stock, views: p.views || 0,
    }));
    const topSelling = [...productsRanked].sort((a,b)=>b.qty-a.qty).filter(p=>p.qty>0).slice(0,5);
    const worstSelling = [...productsRanked].sort((a,b)=>a.qty-b.qty).slice(0,5);
    const totalUnitsSoldAll = allProducts.reduce((s,p)=>s+(allTimeSalesById[p.id]||0),0);
    const totalRevenueFromSalesField = allProducts.reduce((s,p)=>s+(allTimeSalesById[p.id]||0)*(Number(p.price)||0),0);
    const inventoryValue = allProducts.reduce((s,p)=> s + (Number(p.stock)||0) * (Number(p.cost_price)||0), 0);
    const inventoryRetailValue = allProducts.reduce((s,p)=> s + (Number(p.stock)||0) * (Number(p.price)||0), 0);
    const inventoryMarginPct = inventoryValue ? round2((inventoryRetailValue - inventoryValue) / inventoryValue * 100) : 0;
    const topViewed = [...productsRanked].sort((a,b)=>b.views-a.views).slice(0,5);

    // --- источники заказов ---
    const [chRows] = await pool.query("SELECT channel, COUNT(*) AS cnt FROM orders WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY channel", [from, to]);
    const orderSources = chRows.map(r => ({ channel: r.channel || 'direct', count: Number(r.cnt) }));

    // --- маркетинг: бюджет всех кампаний vs выручка по промокодам ---
    const [campaigns] = await pool.query('SELECT c.*, p.code AS promo_code FROM marketing_campaigns c LEFT JOIN promo_codes p ON p.id = c.promo_code_id');
    const totalBudget = campaigns.reduce((s,c)=>s+(Number(c.budget)||0),0);
    let marketingRevenue = 0;
    for (const c of campaigns) {
      if (c.promo_code) {
        const stats = await computePromoStats(c.promo_code);
        marketingRevenue += stats.revenue;
      }
    }
    const roiPct = totalBudget ? round2((marketingRevenue - totalBudget) / totalBudget * 100) : 0;

    res.json({
      period, from, to,
      revenue: round2(revenue), orders_count: ordersCount, avg_check: avgCheck,
      traffic, unique_visitors: uniqueVisitors, conversion, traffic_diff: trafficDiff, traffic_diff_pct: trafficDiffPct,
      chart: { by_day: salesByDay, forecast, forecast_pct: forecastPct },
      customers: {
        repeat_rate: repeatRate, new_rate: newRate, avg_ltv: avgLtv, vip_customers: vipCustomers,
        top_customers: topCustomers,
      },
      products: {
        top_selling: topSelling, worst_selling: worstSelling, top_viewed: topViewed,
        total_count: allProducts.length, total_units_sold: totalUnitsSoldAll, total_revenue_all: round2(totalRevenueFromSalesField),
        inventory_value: round2(inventoryValue), inventory_margin_pct: inventoryMarginPct,
      },
      order_sources: orderSources,
      marketing: { budget: round2(totalBudget), revenue: round2(marketingRevenue), roi_pct: roiPct },
    });
  } catch (e) {
    console.error('Ошибка расчёта дашборда:', e);
    res.status(500).json({ error: 'Не удалось рассчитать дашборд' });
  }
});

// ----------------------------------------------------------------------------
// АНАЛИТИКА — ABC-анализ, оборачиваемость, скидки, RFM, география, тепловая
// карта нагрузки, сравнение периодов
// ----------------------------------------------------------------------------

// предыдущий период той же длины, что и выбранный (для сравнения "период к периоду")
function resolvePrevRange(from, to) {
  const fromD = new Date(from + 'T00:00:00');
  const toD = new Date(to + 'T00:00:00');
  const days = Math.max(1, Math.round((toD - fromD) / 86400000) + 1);
  const prevTo = new Date(fromD); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (days - 1));
  return { prev_from: prevFrom.toISOString().slice(0, 10), prev_to: prevTo.toISOString().slice(0, 10), days };
}

// грубое распознавание района/города по свободному тексту адреса (Душанбе + крупные города РТ)
const GEO_KEYWORDS = [
  ['Сино', /син[оo]/i],
  ['И. Сомони', /сомон[иi]/i],
  ['Фирдавси', /фирдавс/i],
  ['Шохмансур', /шо[хx]мансур|шохмансур/i],
  ['Восе', /вос[еe]/i],
  ['Худжанд', /худжанд|хуҷанд/i],
  ['Куляб', /куляб|кӯлоб/i],
  ['Бохтар', /бохтар/i],
  ['Турсунзаде', /турсунзад/i],
  ['Гиссар', /гиссар|ҳисор/i],
  ['Вахдат', /вахдат/i],
];
function detectDistrict(address) {
  const a = (address || '').trim();
  if (!a) return 'Не указан';
  for (const [label, re] of GEO_KEYWORDS) { if (re.test(a)) return label; }
  return 'Другое';
}

app.get('/api/analytics/summary', requireAuth, async (req, res) => {
  const period = req.query.period || 'month';
  const { from, to } = resolveDateRange(period, req.query.from, req.query.to);
  const { prev_from, prev_to, days } = resolvePrevRange(from, to);

  try {
    // -------- заказы за период и за предыдущий период (для сравнения и ABC/скидок) --------
    const [ordersInRange] = await pool.query(
      "SELECT * FROM orders WHERE status = 'done' AND DATE(COALESCE(completed_at, created_at)) BETWEEN ? AND ?",
      [from, to]
    );
    const [ordersPrevRange] = await pool.query(
      "SELECT * FROM orders WHERE status = 'done' AND DATE(COALESCE(completed_at, created_at)) BETWEEN ? AND ?",
      [prev_from, prev_to]
    );
    const sumRevenue = (rows) => rows.reduce((s, o) => s + Math.max(0, (Number(o.total) || 0) - (Number(o.refunded_amount) || 0)), 0);
    const revenue = sumRevenue(ordersInRange);
    const prevRevenue = sumRevenue(ordersPrevRange);
    const ordersCount = ordersInRange.length;
    const prevOrdersCount = ordersPrevRange.length;
    const avgCheck = ordersCount ? round2(revenue / ordersCount) : 0;
    const prevAvgCheck = prevOrdersCount ? round2(prevRevenue / prevOrdersCount) : 0;
    const pctChange = (cur, prev) => (prev ? round2((cur - prev) / prev * 100) : (cur ? 100 : 0));

    // -------- товары --------
    const [allProducts] = await pool.query('SELECT id, name_ru, price, old_price, cost_price, stock, active FROM products');
    const productById = {}; allProducts.forEach(p => { productById[p.id] = p; });

    // qty/revenue по товарам за выбранный период
    const salesInRange = {};
    for (const o of ordersInRange) {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
      for (const it of items) {
        if (!salesInRange[it.id]) salesInRange[it.id] = { qty: 0, revenue: 0 };
        salesInRange[it.id].qty += Number(it.qty) || 0;
        salesInRange[it.id].revenue += (Number(it.price) || 0) * (Number(it.qty) || 0);
      }
    }

    // ---- 1) ABC-анализ (по выручке за период) ----
    const abcRows = Object.keys(salesInRange).map(id => ({
      id: Number(id),
      name: (productById[id] && productById[id].name_ru) || `Товар #${id}`,
      qty: salesInRange[id].qty,
      revenue: round2(salesInRange[id].revenue),
    })).sort((a, b) => b.revenue - a.revenue);
    const abcTotalRevenue = abcRows.reduce((s, r) => s + r.revenue, 0);
    let abcCum = 0;
    const abc = abcRows.map(r => {
      abcCum += r.revenue;
      const cumPct = abcTotalRevenue ? round2(abcCum / abcTotalRevenue * 100) : 0;
      const grade = cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C';
      return { ...r, share_pct: abcTotalRevenue ? round2(r.revenue / abcTotalRevenue * 100) : 0, cum_pct: cumPct, grade };
    });

    // ---- 2) Оборачиваемость склада ("мёртвый товар") ----
    const turnover = allProducts.filter(p => p.active !== 0 && p.stock != null).map(p => {
      const sold = (salesInRange[p.id] && salesInRange[p.id].qty) || 0;
      const avgDaily = sold / days;
      const stock = Number(p.stock) || 0;
      const daysToSell = avgDaily > 0 ? Math.round(stock / avgDaily) : null;
      let status = 'ok';
      if (stock > 0 && sold === 0) status = 'dead';
      else if (daysToSell != null && daysToSell > 45) status = 'slow';
      else if (daysToSell != null && daysToSell > 14) status = 'ok';
      else if (daysToSell == null) status = stock > 0 ? 'dead' : 'ok';
      return { id: p.id, name: p.name_ru, stock, sold_in_period: sold, avg_daily_sales: round2(avgDaily), days_to_sell: daysToSell, status };
    }).sort((a, b) => (b.days_to_sell || 9999) - (a.days_to_sell || 9999));

    // ---- 3) Эффективность скидок ----
    const discounted = allProducts.filter(p => p.active !== 0 && Number(p.old_price) > Number(p.price));
    const regular = allProducts.filter(p => p.active !== 0 && !(Number(p.old_price) > Number(p.price)));
    const avgDailyOf = (list) => {
      if (!list.length) return 0;
      const totalQty = list.reduce((s, p) => s + ((salesInRange[p.id] && salesInRange[p.id].qty) || 0), 0);
      return round2((totalQty / days) / list.length);
    };
    const discountedAvgDaily = avgDailyOf(discounted);
    const regularAvgDaily = avgDailyOf(regular);
    const discountEffectiveness = {
      discounted_count: discounted.length,
      regular_count: regular.length,
      discounted_avg_daily_per_item: discountedAvgDaily,
      regular_avg_daily_per_item: regularAvgDaily,
      uplift_pct: regularAvgDaily ? round2((discountedAvgDaily - regularAvgDaily) / regularAvgDaily * 100) : (discountedAvgDaily ? 100 : 0),
    };

    // ---- 4) RFM-сегментация (по всем заказам "Выполнен", человеческим языком) ----
    const [allDone] = await pool.query(
      "SELECT customer_name, customer_phone, customer_address, total, COALESCE(completed_at, created_at) AS done_at FROM orders WHERE status = 'done'"
    );
    const custMap = {};
    for (const o of allDone) {
      const phone = (o.customer_phone || '').replace(/\D/g, '');
      if (!phone) continue;
      if (!custMap[phone]) custMap[phone] = { name: o.customer_name, phone, orders: 0, total: 0, lastDate: null, address: o.customer_address };
      const c = custMap[phone];
      c.orders += 1;
      c.total += Number(o.total) || 0;
      const d = new Date(o.done_at);
      if (!c.lastDate || d > c.lastDate) { c.lastDate = d; c.address = o.customer_address || c.address; }
    }
    const now = new Date();
    const segments = { new: [], loyal: [], active: [], dormant: [] };
    Object.values(custMap).forEach(c => {
      const recencyDays = c.lastDate ? Math.floor((now - c.lastDate) / 86400000) : 9999;
      c.recency_days = recencyDays;
      if (recencyDays > 60) segments.dormant.push(c);
      else if (c.orders >= 3) segments.loyal.push(c);
      else if (c.orders === 1 && recencyDays <= 30) segments.new.push(c);
      else segments.active.push(c);
    });
    const totalCust = Object.keys(custMap).length || 1;
    const rfm = {
      total_customers: Object.keys(custMap).length,
      segments: [
        { key: 'new', label: 'Новенькие', count: segments.new.length, pct: round2(segments.new.length / totalCust * 100) },
        { key: 'loyal', label: 'Постоянные клиенты', count: segments.loyal.length, pct: round2(segments.loyal.length / totalCust * 100) },
        { key: 'active', label: 'Активные', count: segments.active.length, pct: round2(segments.active.length / totalCust * 100) },
        { key: 'dormant', label: 'Давно не покупали (>60 дн.)', count: segments.dormant.length, pct: round2(segments.dormant.length / totalCust * 100) },
      ],
      dormant_top: segments.dormant.sort((a, b) => b.total - a.total).slice(0, 10)
        .map(c => ({ name: c.name, phone: c.phone, orders: c.orders, total: round2(c.total), recency_days: c.recency_days })),
      loyal_top: segments.loyal.sort((a, b) => b.total - a.total).slice(0, 10)
        .map(c => ({ name: c.name, phone: c.phone, orders: c.orders, total: round2(c.total), recency_days: c.recency_days })),
    };

    // ---- 5) География ----
    const geoMap = {};
    Object.values(custMap).forEach(c => {
      const key = detectDistrict(c.address);
      if (!geoMap[key]) geoMap[key] = { district: key, customers: 0, orders: 0, revenue: 0 };
      geoMap[key].customers += 1; geoMap[key].orders += c.orders; geoMap[key].revenue += c.total;
    });
    const geo = Object.values(geoMap).map(g => ({ ...g, revenue: round2(g.revenue) })).sort((a, b) => b.revenue - a.revenue);

    // ---- 6.5) Тренд выручки за последние 30 дней (график "вверх/вниз", независим от выбранного периода) ----
    const [trendRows] = await pool.query(
      "SELECT DATE(COALESCE(completed_at, created_at)) AS d, SUM(total - COALESCE(refunded_amount,0)) AS revenue " +
      "FROM orders WHERE status = 'done' AND DATE(COALESCE(completed_at, created_at)) >= DATE_SUB(CURDATE(), INTERVAL 29 DAY) " +
      "GROUP BY d ORDER BY d"
    );
    const trendMap = {}; trendRows.forEach(r => { trendMap[r.d.toISOString ? r.d.toISOString().slice(0,10) : String(r.d)] = round2(Number(r.revenue) || 0); });
    const revenueTrend = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      revenueTrend.push({ date: key, label: key.slice(8,10)+'.'+key.slice(5,7), revenue: trendMap[key] || 0 });
    }

    // ---- 6.6) ABC — сводка по группам для круговой диаграммы ----
    const abcRevenueByGrade = { A: 0, B: 0, C: 0 };
    abc.forEach(r => { abcRevenueByGrade[r.grade] += r.revenue; });

    // ---- 6) Тепловая карта нагрузки (день недели x час), последние 90 дней, все заказы кроме отменённых ----
    const [heatRows] = await pool.query(
      "SELECT DAYOFWEEK(created_at) AS dow, HOUR(created_at) AS hr, COUNT(*) AS cnt FROM orders " +
      "WHERE status != 'cancel' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) GROUP BY dow, hr"
    );
    // DAYOFWEEK: 1=вс..7=сб -> переводим в 0=пн..6=вс
    const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    let peak = { day: 0, hour: 0, cnt: 0 };
    for (const r of heatRows) {
      const day = (Number(r.dow) + 5) % 7; // 1(вс)->6, 2(пн)->0, ... 7(сб)->5
      const hour = Number(r.hr);
      heatmap[day][hour] = Number(r.cnt);
      if (Number(r.cnt) > peak.cnt) peak = { day, hour, cnt: Number(r.cnt) };
    }

    // ---- 7) Воронка продаж: просмотр → корзина → начали оформление → оформили заказ → оплатили/забрали ----
    const [[viewRow]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM funnel_events WHERE event_type='view' AND DATE(created_at) BETWEEN ? AND ?", [from, to]
    );
    const [[cartRow]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM funnel_events WHERE event_type='cart' AND DATE(created_at) BETWEEN ? AND ?", [from, to]
    );
    const [[checkoutRow]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM funnel_events WHERE event_type='checkout' AND DATE(created_at) BETWEEN ? AND ?", [from, to]
    );
    const [[ordersCreatedRow]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM orders WHERE DATE(created_at) BETWEEN ? AND ?", [from, to]
    );
    const [[ordersPaidRow]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM orders WHERE DATE(created_at) BETWEEN ? AND ? AND status='done'", [from, to]
    );
    const funnelCounts = [
      { key: 'view', label: 'Просмотр товара', count: Number(viewRow.cnt) || 0 },
      { key: 'cart', label: 'Добавили в корзину', count: Number(cartRow.cnt) || 0 },
      { key: 'checkout', label: 'Начали оформление', count: Number(checkoutRow.cnt) || 0 },
      { key: 'order', label: 'Оформили заказ', count: Number(ordersCreatedRow.cnt) || 0 },
      { key: 'paid', label: 'Оплатили / забрали', count: Number(ordersPaidRow.cnt) || 0 },
    ];
    const firstCount = funnelCounts[0].count || 0;
    let prevCount = null;
    const funnel = funnelCounts.map(s => {
      const pctOfFirst = firstCount ? round2(s.count / firstCount * 100) : 0;
      const convFromPrev = (prevCount != null && prevCount > 0) ? round2(s.count / prevCount * 100) : null;
      prevCount = s.count;
      return { ...s, pct_of_first: pctOfFirst, conv_from_prev_pct: convFromPrev };
    });
    const funnelHasData = funnelCounts.some(s => s.count > 0);

    // ---- 8) Трафик: посещения, уникальные посетители, конверсия ----
    const [[visitRow]] = await pool.query('SELECT COUNT(*) AS cnt, COUNT(DISTINCT visitor_id) AS uniq FROM site_visits WHERE DATE(created_at) BETWEEN ? AND ?', [from, to]);
    const traffic = Number(visitRow.cnt) || 0;
    const uniqueVisitors = Number(visitRow.uniq) || 0;
    // конверсия считается от уникальных посетителей — точнее, чем от общего числа заходов на сайт
    const conversion = uniqueVisitors ? round2(ordersCount / uniqueVisitors * 100) : (traffic ? round2(ordersCount / traffic * 100) : 0);

    // ---- 9) Источники трафика (UTM) — реклама vs органика, по кампаниям ----
    const [visitsBySource] = await pool.query(
      "SELECT COALESCE(NULLIF(utm_source,''),'(органика)') AS src, COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS uniq " +
      "FROM site_visits WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY src", [from, to]
    );
    const [funnelBySource] = await pool.query(
      "SELECT COALESCE(NULLIF(utm_source,''),'(органика)') AS src, event_type, COUNT(*) AS cnt " +
      "FROM funnel_events WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY src, event_type", [from, to]
    );
    const [ordersBySource] = await pool.query(
      "SELECT COALESCE(NULLIF(utm_source,''),'(органика)') AS src, COUNT(*) AS cnt, " +
      "COALESCE(SUM(CASE WHEN status='done' THEN total - COALESCE(refunded_amount,0) ELSE 0 END),0) AS revenue " +
      "FROM orders WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY src", [from, to]
    );
    const sourceMap = {};
    const touchSource = (src) => { if (!sourceMap[src]) sourceMap[src] = { source: src, visits: 0, unique_visitors: 0, view: 0, cart: 0, checkout: 0, orders: 0, revenue: 0 }; return sourceMap[src]; };
    visitsBySource.forEach(r => { const s = touchSource(r.src); s.visits = Number(r.visits) || 0; s.unique_visitors = Number(r.uniq) || 0; });
    funnelBySource.forEach(r => { const s = touchSource(r.src); s[r.event_type] = Number(r.cnt) || 0; });
    ordersBySource.forEach(r => { const s = touchSource(r.src); s.orders = Number(r.cnt) || 0; s.revenue = round2(Number(r.revenue) || 0); });
    const trafficSources = Object.values(sourceMap).map(s => ({
      ...s, conversion_pct: s.unique_visitors ? round2(s.orders / s.unique_visitors * 100) : (s.visits ? round2(s.orders / s.visits * 100) : 0),
    })).sort((a, b) => b.revenue - a.revenue);

    const [campaignRows] = await pool.query(
      "SELECT utm_campaign AS campaign, COUNT(*) AS orders_count, " +
      "COALESCE(SUM(CASE WHEN status='done' THEN total - COALESCE(refunded_amount,0) ELSE 0 END),0) AS revenue " +
      "FROM orders WHERE DATE(created_at) BETWEEN ? AND ? AND utm_campaign IS NOT NULL AND utm_campaign <> '' GROUP BY utm_campaign ORDER BY revenue DESC LIMIT 10",
      [from, to]
    );
    const campaigns = campaignRows.map(r => ({ campaign: r.campaign, orders_count: Number(r.orders_count) || 0, revenue: round2(Number(r.revenue) || 0) }));

    res.json({
      period, from, to, days,
      compare: {
        prev_from, prev_to,
        revenue: round2(revenue), prev_revenue: round2(prevRevenue), revenue_pct: pctChange(revenue, prevRevenue),
        orders_count: ordersCount, prev_orders_count: prevOrdersCount, orders_pct: pctChange(ordersCount, prevOrdersCount),
        avg_check: avgCheck, prev_avg_check: prevAvgCheck, avg_check_pct: pctChange(avgCheck, prevAvgCheck),
      },
      traffic: { total: traffic, unique_visitors: uniqueVisitors, conversion_pct: conversion },
      funnel: { steps: funnel, has_data: funnelHasData },
      revenue_trend: revenueTrend,
      abc_by_grade: [
        { grade: 'A', revenue: round2(abcRevenueByGrade.A) },
        { grade: 'B', revenue: round2(abcRevenueByGrade.B) },
        { grade: 'C', revenue: round2(abcRevenueByGrade.C) },
      ],
      traffic_sources: trafficSources,
      campaigns,
      abc,
      turnover,
      discount_effectiveness: discountEffectiveness,
      rfm,
      geo,
      heatmap: { grid: heatmap, peak: { day: peak.day, hour: peak.hour, count: peak.cnt } },
    });
  } catch (e) {
    console.error('Ошибка расчёта аналитики:', e);
    res.status(500).json({ error: 'Не удалось рассчитать аналитику' });
  }
});

// админ может вручную запустить отправку ежедневной сводки — удобно для проверки настройки Telegram
app.post('/api/analytics/send-digest-test', requireAuth, async (req, res) => {
  if (!OWNER_TELEGRAM_CHAT_ID) {
    return res.status(400).json({ error: 'Сначала задайте OWNER_TELEGRAM_CHAT_ID в переменных окружения Railway' });
  }
  try {
    await sendDailyDigest();
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка тестовой отправки сводки:', e);
    res.status(500).json({ error: 'Не удалось отправить сводку' });
  }
});

// ----------------------------------------------------------------------------
// МАРКЕТИНГ — промокоды, рекламные кампании, блогеры, аудитория
// ----------------------------------------------------------------------------

// проверить промокод (публично — вызывается с сайта при оформлении заказа)
app.post('/api/promo-codes/validate', async (req, res) => {
  const { code, subtotal } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Укажите промокод' });
  try {
    const [[promo]] = await pool.query('SELECT * FROM promo_codes WHERE code = ? AND active = 1', [code.trim().toUpperCase()]);
    if (!promo) return res.status(404).json({ error: 'Промокод не найден или отключён' });
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Срок действия промокода истёк' });
    }
    if (promo.usage_limit != null) {
      const used = await promoUsageCount(promo.id);
      if (used >= promo.usage_limit) return res.status(400).json({ error: 'Лимит использований промокода исчерпан' });
    }
    const base = Number(subtotal) || 0;
    let discount = promo.discount_type === 'percent' ? round2(base * Number(promo.discount_value) / 100) : round2(Number(promo.discount_value));
    discount = Math.min(discount, base);
    res.json({ ok: true, code: promo.code, discount_type: promo.discount_type, discount_value: Number(promo.discount_value), discount_amount: discount });
  } catch (e) {
    console.error('Ошибка проверки промокода:', e);
    res.status(500).json({ error: 'Не удалось проверить промокод' });
  }
});

app.get('/api/promo-codes', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    const withUsage = await Promise.all(rows.map(async p => {
      const used = await promoUsageCount(p.id);
      const [[revRow]] = await pool.query("SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE promo_code = ? AND status = 'done'", [p.code]);
      return { ...p, used_count: used, revenue: round2(Number(revRow.total) || 0) };
    }));
    res.json(withUsage);
  } catch (e) {
    console.error('Ошибка получения промокодов:', e);
    res.status(500).json({ error: 'Не удалось получить промокоды' });
  }
});

app.post('/api/promo-codes', requireAuth, async (req, res) => {
  const { code, discount_type, discount_value, usage_limit, expires_at } = req.body || {};
  if (!code || !discount_value) return res.status(400).json({ error: 'Укажите код и размер скидки' });
  try {
    await pool.query(
      'INSERT INTO promo_codes (code, discount_type, discount_value, usage_limit, expires_at, active) VALUES (?, ?, ?, ?, ?, 1)',
      [code.trim().toUpperCase(), discount_type === 'fixed' ? 'fixed' : 'percent', discount_value, usage_limit || null, expires_at || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка добавления промокода:', e);
    res.status(500).json({ error: 'Не удалось добавить (возможно, такой код уже есть)' });
  }
});

app.patch('/api/promo-codes/:id', requireAuth, async (req, res) => {
  const allowed = ['discount_type','discount_value','usage_limit','expires_at','active'];
  const body = req.body || {};
  const sets = []; const values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) { sets.push(`${key} = ?`); values.push(key === 'active' ? (body[key]?1:0) : body[key]); }
  }
  if (!sets.length) return res.json({ ok: true });
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE promo_codes SET ${sets.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка изменения промокода:', e);
    res.status(500).json({ error: 'Не удалось изменить промокод' });
  }
});

app.delete('/api/promo-codes/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM promo_codes WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления промокода:', e);
    res.status(500).json({ error: 'Не удалось удалить промокод' });
  }
});

// вычисляет для промокода: сколько заказов и выручки он принёс
async function computePromoStats(code) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS orders_count, COALESCE(SUM(total),0) AS revenue FROM orders WHERE promo_code = ? AND status = 'done'",
    [code]
  );
  return { orders_count: Number(row.orders_count) || 0, revenue: round2(Number(row.revenue) || 0) };
}

app.get('/api/marketing/campaigns', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, p.code AS promo_code FROM marketing_campaigns c LEFT JOIN promo_codes p ON p.id = c.promo_code_id ORDER BY c.created_at DESC`
    );
    const withStats = await Promise.all(rows.map(async c => {
      const stats = c.promo_code ? await computePromoStats(c.promo_code) : { orders_count: 0, revenue: 0 };
      const roas = Number(c.budget) > 0 ? round2(stats.revenue / Number(c.budget)) : null;
      return { ...c, stats: { ...stats, roas } };
    }));
    res.json(withStats);
  } catch (e) {
    console.error('Ошибка получения кампаний:', e);
    res.status(500).json({ error: 'Не удалось получить кампании' });
  }
});

app.post('/api/marketing/campaigns', requireAuth, async (req, res) => {
  const { name, platform, budget, start_date, end_date, promo_code_id, note } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Укажите название кампании' });
  try {
    await pool.query(
      `INSERT INTO marketing_campaigns (name, platform, budget, start_date, end_date, promo_code_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, platform || null, budget || 0, start_date || null, end_date || null, promo_code_id || null, note || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка добавления кампании:', e);
    res.status(500).json({ error: 'Не удалось добавить кампанию' });
  }
});

app.delete('/api/marketing/campaigns/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM marketing_campaigns WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления кампании:', e);
    res.status(500).json({ error: 'Не удалось удалить кампанию' });
  }
});

app.get('/api/marketing/bloggers', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, p.code AS promo_code FROM bloggers b LEFT JOIN promo_codes p ON p.id = b.promo_code_id ORDER BY b.created_at DESC`
    );
    const withStats = await Promise.all(rows.map(async b => {
      const stats = b.promo_code ? await computePromoStats(b.promo_code) : { orders_count: 0, revenue: 0 };
      const owed = b.deal_type === 'fixed' ? Number(b.fee_amount) || 0 : round2(stats.revenue * (Number(b.fee_amount) || 0) / 100);
      return { ...b, stats: { ...stats, owed } };
    }));
    res.json(withStats);
  } catch (e) {
    console.error('Ошибка получения блогеров:', e);
    res.status(500).json({ error: 'Не удалось получить блогеров' });
  }
});

app.post('/api/marketing/bloggers', requireAuth, async (req, res) => {
  const { name, platform, phone, telegram, deal_type, fee_amount, promo_code_id, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Укажите имя блогера' });
  try {
    await pool.query(
      `INSERT INTO bloggers (name, platform, phone, telegram, deal_type, fee_amount, promo_code_id, notes, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, platform || null, phone || null, telegram || null, deal_type === 'percent' ? 'percent' : 'fixed', fee_amount || 0, promo_code_id || null, notes || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка добавления блогера:', e);
    res.status(500).json({ error: 'Не удалось добавить блогера' });
  }
});

app.delete('/api/marketing/bloggers/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM bloggers WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления блогера:', e);
    res.status(500).json({ error: 'Не удалось удалить блогера' });
  }
});

// аудитория — считаем только из своих же заказов, без внешних сервисов
app.get('/api/marketing/audience', requireAuth, async (req, res) => {
  try {
    const [orders] = await pool.query("SELECT customer_phone, total, created_at FROM orders WHERE status = 'done'");
    const byPhone = {};
    const byHour = Array(24).fill(0);
    const byWeekday = Array(7).fill(0);
    for (const o of orders) {
      const phone = (o.customer_phone || '').replace(/\D/g, '');
      if (phone) {
        byPhone[phone] = (byPhone[phone] || 0) + 1;
      }
      const d = new Date(o.created_at);
      byHour[d.getHours()] += 1;
      byWeekday[d.getDay()] += 1;
    }
    const totalCustomers = Object.keys(byPhone).length;
    const repeatCustomers = Object.values(byPhone).filter(c => c > 1).length;
    const customers3plus = Object.values(byPhone).filter(c => c >= 3).length;
    const newCustomers = totalCustomers - repeatCustomers;
    const avgOrdersPerCustomer = totalCustomers ? round2(orders.length / totalCustomers) : 0;

    res.json({
      total_customers: totalCustomers,
      new_customers: newCustomers,
      repeat_customers: repeatCustomers,
      repeat_rate: totalCustomers ? round2(repeatCustomers / totalCustomers * 100) : 0,
      avg_orders_per_customer: avgOrdersPerCustomer,
      customers_2plus: repeatCustomers,
      customers_3plus: customers3plus,
      by_hour: byHour,
      by_weekday: byWeekday,
    });
  } catch (e) {
    console.error('Ошибка расчёта аудитории:', e);
    res.status(500).json({ error: 'Не удалось рассчитать аудиторию' });
  }
});

// ----------------------------------------------------------------------------
// ПАРТНЁРЫ — учёт комиссии/опта, расходов и выплат
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// общие показатели компании за всё время (нужны, чтобы посчитать долю расходов
// для партнёров с комиссией "от чистой прибыли"). Кэшируем на минуту, чтобы не
// пересчитывать заново при каждом партнёре в списке (их может быть много).
let companyTotalsCache = null;
let companyTotalsCacheAt = 0;
async function getCompanyTotalsAllTime() {
  const now = Date.now();
  if (companyTotalsCache && (now - companyTotalsCacheAt) < 60000) return companyTotalsCache;

  const [[revRow]] = await pool.query("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status = 'done'");
  const totalRevenue = Number(revRow.total) || 0;

  const [couriersAll] = await pool.query('SELECT id, salary_type, salary_rate FROM couriers');
  let courierSalaryAllTime = 0;
  for (const c of couriersAll) {
    const [[dRow]] = await pool.query("SELECT COUNT(*) AS cnt FROM orders WHERE courier_id = ? AND delivery_status = 'delivered'", [c.id]);
    const deliveries = Number(dRow.cnt) || 0;
    courierSalaryAllTime += c.salary_type === 'fixed' ? (Number(c.salary_rate) || 0) : deliveries * (Number(c.salary_rate) || 0);
  }

  const [[genRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM general_expenses');
  const generalExpensesAllTime = Number(genRow.total) || 0;

  let adExpensesAllTime = 0;
  try {
    const metaAll = await fetchMetaAdsSpend('all');
    if (metaAll.connected) adExpensesAllTime = Number(metaAll.total_spend) || 0;
  } catch (e) { /* Meta недоступна — просто не учитываем в общем пуле расходов */ }

  companyTotalsCache = {
    totalRevenue,
    totalOperatingExpenses: courierSalaryAllTime + generalExpensesAllTime + adExpensesAllTime,
  };
  companyTotalsCacheAt = now;
  return companyTotalsCache;
}

// считает статистику по одному партнёру: продажи, что причитается, расходы, выплаты, остаток долга.
// Работает для двух типов сделки:
//   commission — партнёру причитается % от МАРЖИ (gross) или % от ЧИСТОЙ прибыли (net, за вычетом
//                доли операционных расходов, пропорциональной его выручке)
//   wholesale  — партнёру причитается себестоимость проданного его товара (это его цена, не наша).
//                Если оплата "в кредит" (wholesale_payment_timing='on_sale') — есть срок оплаты
//                (wholesale_credit_days от даты поступления товара) и штраф за просрочку в % в день.
async function computePartnerStats(partnerId, partner, includeOrders) {
  const [productRows] = await pool.query(
    'SELECT id, name_ru, price, cost_price, stock, image_data, active, received_at, created_at FROM products WHERE partner_id = ?',
    [partnerId]
  );
  const productIds = new Set(productRows.map(p => p.id));
  const productById = {};
  productRows.forEach(p => { productById[p.id] = p; });

  const isWholesale = partner.deal_type === 'wholesale';
  const isCredit = isWholesale && partner.wholesale_payment_timing !== 'immediate';
  const commissionRate = Number(partner.commission_percent) || 0;
  const basis = partner.commission_basis === 'net' ? 'net' : 'gross';

  const [orders] = await pool.query("SELECT id, created_at, completed_at, status, total, refunded_amount, customer_name, customer_phone, items FROM orders WHERE status = 'done'");
  let revenue = 0;      // сумма продаж по розничной цене
  let marginTotal = 0;  // сумма (цена - себестоимость) по всем проданным товарам этого партнёра
  let costTotal = 0;    // сумма себестоимости проданного (это то, что причитается оптовому партнёру)
  let unitsSold = 0;
  let ordersCount = 0;
  const orderList = [];
  const productStats = {};
  const marginByDay = {}; // 'YYYY-MM-DD' -> { margin, revenue } — для истории, оставлено на будущее
  const matchedOrderIds = []; // все заказы этого партнёра — нужны, чтобы узнать доставку по каждому
  productRows.forEach(p => { productStats[p.id] = { units: 0, orders: new Set(), revenue: 0, margin: 0, cost: 0 }; });

  for (const o of orders) {
    const refundFactor = (Number(o.total) || 0) > 0 ? Math.max(0, ((Number(o.total) || 0) - (Number(o.refunded_amount) || 0)) / (Number(o.total) || 1)) : 1;
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    let orderRevenue = 0, orderMargin = 0, orderCost = 0;
    const matchedItems = [];
    for (const item of items) {
      if (productIds.has(item.id)) {
        const qty = Number(item.qty) || 0;
        const priceSum = (Number(item.price) || 0) * qty * refundFactor;
        const cost = Number(productById[item.id].cost_price) || 0;
        const costSum = cost * qty * refundFactor;
        const marginSum = priceSum - costSum;
        revenue += priceSum; marginTotal += marginSum; costTotal += costSum; unitsSold += qty;
        orderRevenue += priceSum; orderMargin += marginSum; orderCost += costSum;
        matchedItems.push(item);
        const ps = productStats[item.id];
        ps.units += qty; ps.orders.add(o.id); ps.revenue += priceSum; ps.margin += marginSum; ps.cost += costSum;
      }
    }
    if (matchedItems.length) {
      ordersCount += 1;
      matchedOrderIds.push(o.id);
      const dayKey = new Date(o.completed_at || o.created_at).toISOString().slice(0, 10);
      if (!marginByDay[dayKey]) marginByDay[dayKey] = { margin: 0, revenue: 0 };
      marginByDay[dayKey].margin += orderMargin;
      marginByDay[dayKey].revenue += orderRevenue;
      if (includeOrders) {
        orderList.push({
          id: o.id, date: o.created_at, status: o.status,
          customer_name: o.customer_name, customer_phone: o.customer_phone,
          items: matchedItems,
          revenue: round2(orderRevenue), margin: round2(orderMargin), cost: round2(orderCost),
        });
      }
    }
  }

  // сколько причитается партнёру от продаж — считается по-разному в зависимости от типа сделки
  let owedFromSales = 0;
  if (isWholesale) {
    owedFromSales = costTotal; // оптовому партнёру причитается его себестоимость проданного
  } else if (basis === 'net') {
    // "чистая прибыль" здесь = выручка партнёра - себестоимость его товара - доставка ЕГО заказов.
    // Реклама и общие расходы бизнеса сюда НЕ входят — по договорённости комиссия считается
    // только от прямой прибыли по товару, а не от общих трат магазина.
    let deliveryCostForPartner = 0;
    if (matchedOrderIds.length) {
      const [deliveryRows] = await pool.query(
        `SELECT o.id, o.delivery_status, c.salary_type, c.salary_rate
         FROM orders o LEFT JOIN couriers c ON c.id = o.courier_id
         WHERE o.id IN (${matchedOrderIds.map(() => '?').join(',')})`,
        matchedOrderIds
      );
      for (const row of deliveryRows) {
        if (row.delivery_status === 'delivered' && row.salary_type === 'per_delivery') {
          deliveryCostForPartner += Number(row.salary_rate) || 0;
        }
        // курьеров с фиксированной (не за доставку) ставкой сюда не включаем — их зарплату
        // нельзя честно разделить между конкретными заказами
      }
    }
    owedFromSales = Math.max(0, marginTotal - deliveryCostForPartner) * commissionRate / 100;
  } else {
    owedFromSales = marginTotal * commissionRate / 100;
  }

  const [[expenseRow]] = await pool.query(
    'SELECT COALESCE(SUM(amount * partner_share_percent / 100), 0) AS total FROM partner_expenses WHERE partner_id = ?',
    [partnerId]
  );
  const [[payoutRow]] = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM partner_payouts WHERE partner_id = ?',
    [partnerId]
  );
  const expensesTotal = Number(expenseRow.total) || 0;
  const paidTotal = Number(payoutRow.total) || 0;

  // штраф за просрочку — только для оптовых партнёров "в кредит"
  let penaltyTotal = 0;
  const overdueProducts = [];
  if (isCredit) {
    const creditDays = Number(partner.wholesale_credit_days) || 0;
    const penaltyPctPerDay = Number(partner.wholesale_penalty_percent_per_day) || 0;
    const today = new Date();

    // долги по каждому товару, отсортированные по сроку — самые старые первыми
    const debts = productRows
      .map(p => ({ product: p, owed: productStats[p.id].cost }))
      .filter(d => d.owed > 0)
      .map(d => {
        const receivedRaw = d.product.received_at || d.product.created_at;
        const dueDate = new Date(receivedRaw);
        dueDate.setDate(dueDate.getDate() + creditDays);
        return { ...d, dueDate };
      })
      .sort((a, b) => a.dueDate - b.dueDate);

    // выплаты гасят самый старый долг первым (FIFO)
    let remainingPaid = paidTotal - expensesTotal;
    for (const d of debts) {
      let unpaid = d.owed;
      if (remainingPaid > 0) {
        const applied = Math.min(remainingPaid, unpaid);
        unpaid -= applied;
        remainingPaid -= applied;
      }
      if (unpaid > 0 && today > d.dueDate && penaltyPctPerDay > 0) {
        const daysOverdue = Math.floor((today - d.dueDate) / (1000 * 60 * 60 * 24));
        const penalty = unpaid * penaltyPctPerDay / 100 * daysOverdue;
        penaltyTotal += penalty;
        overdueProducts.push({
          product_id: d.product.id, name_ru: d.product.name_ru,
          unpaid: round2(unpaid), days_overdue: daysOverdue, penalty: round2(penalty),
          due_date: d.dueDate,
        });
      }
    }
  }

  const balanceDue = owedFromSales - expensesTotal - paidTotal + penaltyTotal;

  const productsWithStats = productRows.map(p => {
    const ps = productStats[p.id];
    return {
      id: p.id, name_ru: p.name_ru, price: p.price, cost_price: p.cost_price,
      stock: p.stock, image_data: p.image_data, active: p.active, received_at: p.received_at,
      units_sold: ps.units, orders_count: ps.orders.size,
      revenue: round2(ps.revenue),
      owed: round2(isWholesale ? ps.cost : (basis === 'gross' ? ps.margin * commissionRate / 100 : 0)),
    };
  });

  return {
    products_count: productRows.length,
    orders_count: ordersCount,
    units_sold: unitsSold,
    revenue: round2(revenue),
    margin_total: round2(marginTotal),
    our_profit: round2(revenue - owedFromSales),
    owed_from_sales: round2(owedFromSales),
    expenses_total: round2(expensesTotal),
    paid_total: round2(paidTotal),
    penalty_total: round2(penaltyTotal),
    overdue_products: overdueProducts,
    products_stats: productsWithStats,
    balance_due: round2(balanceDue),
    orders: includeOrders ? orderList : undefined,
  };
}

app.get('/api/partners', requireAuth, async (req, res) => {
  try {
    const [partners] = await pool.query('SELECT * FROM partners ORDER BY active DESC, created_at DESC');
    const withStats = await Promise.all(partners.map(async p => ({ ...p, stats: await computePartnerStats(p.id, p) })));
    res.json(withStats);
  } catch (e) {
    console.error('Ошибка получения партнёров:', e);
    res.status(500).json({ error: 'Не удалось получить партнёров' });
  }
});

app.get('/api/partners/:id', requireAuth, async (req, res) => {
  try {
    const [[partner]] = await pool.query('SELECT * FROM partners WHERE id = ?', [req.params.id]);
    if (!partner) return res.status(404).json({ error: 'Партнёр не найден' });
    const [expenses] = await pool.query('SELECT * FROM partner_expenses WHERE partner_id = ? ORDER BY created_at DESC', [req.params.id]);
    const [payouts] = await pool.query('SELECT * FROM partner_payouts WHERE partner_id = ? ORDER BY created_at DESC', [req.params.id]);
    const [products] = await pool.query('SELECT id, name_ru, price, cost_price FROM products WHERE partner_id = ?', [req.params.id]);
    const stats = await computePartnerStats(partner.id, partner, true);
    res.json({ ...partner, stats, expenses, payouts, products });
  } catch (e) {
    console.error('Ошибка получения партнёра:', e);
    res.status(500).json({ error: 'Не удалось получить партнёра' });
  }
});

// сравнение всех трёх способов расчёта комиссии за произвольный период (от даты до даты) —
// чтобы видеть сразу все варианты и свериться самостоятельно, независимо от того, какой
// способ сейчас реально настроен у партнёра
app.get('/api/partners/:id/compare', requireAuth, async (req, res) => {
  try {
    const [[partner]] = await pool.query('SELECT * FROM partners WHERE id = ?', [req.params.id]);
    if (!partner) return res.status(404).json({ error: 'Партнёр не найден' });

    const from = req.query.from, to = req.query.to;
    if (!from || !to) return res.status(400).json({ error: 'Укажите даты from и to' });

    const [productRows] = await pool.query('SELECT id, name_ru, price, cost_price FROM products WHERE partner_id = ?', [req.params.id]);
    const productIds = new Set(productRows.map(p => p.id));
    const costById = {};
    productRows.forEach(p => { costById[p.id] = Number(p.cost_price) || 0; });

    const [orders] = await pool.query(
      "SELECT id, items FROM orders WHERE status = 'done' AND DATE(COALESCE(completed_at, created_at)) BETWEEN ? AND ?",
      [from, to]
    );

    let revenue = 0, cost = 0, margin = 0;
    const matchedOrderIds = [];
    for (const o of orders) {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
      let matched = false;
      for (const item of items) {
        if (productIds.has(item.id)) {
          matched = true;
          const qty = Number(item.qty) || 0;
          const priceSum = (Number(item.price) || 0) * qty;
          const costSum = (costById[item.id] || 0) * qty;
          revenue += priceSum; cost += costSum; margin += (priceSum - costSum);
        }
      }
      if (matched) matchedOrderIds.push(o.id);
    }

    // доставка по заказам именно этого партнёра — нужна для расчёта "по чистой прибыли"
    let deliveryCost = 0;
    if (matchedOrderIds.length) {
      const [deliveryRows] = await pool.query(
        `SELECT o.id, o.delivery_status, c.salary_type, c.salary_rate
         FROM orders o LEFT JOIN couriers c ON c.id = o.courier_id
         WHERE o.id IN (${matchedOrderIds.map(() => '?').join(',')})`,
        matchedOrderIds
      );
      for (const row of deliveryRows) {
        if (row.delivery_status === 'delivered' && row.salary_type === 'per_delivery') {
          deliveryCost += Number(row.salary_rate) || 0;
        }
      }
    }

    // общие расходы бизнеса за этот же период — показываем для справки (в расчёт "по чистой"
    // сейчас НЕ входят, только доставка — так решили: комиссия не должна зависеть от рекламы и т.п.)
    const [[genRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM general_expenses WHERE expense_date BETWEEN ? AND ?', [from, to]);
    const generalExpensesPeriod = Number(genRow.total) || 0;

    const pct = Number(partner.commission_percent) || 0;

    res.json({
      from, to,
      revenue: round2(revenue), cost: round2(cost), margin: round2(margin),
      delivery_cost: round2(deliveryCost),
      general_expenses_period: round2(generalExpensesPeriod),
      commission_percent: pct,
      by_wholesale: round2(cost),
      by_gross: round2(margin * pct / 100),
      by_net: round2(Math.max(0, margin - deliveryCost) * pct / 100),
      current_basis: partner.deal_type === 'wholesale' ? 'wholesale' : partner.commission_basis,
    });
  } catch (e) {
    console.error('Ошибка сравнения расчёта партнёра:', e);
    res.status(500).json({ error: 'Не удалось посчитать сравнение' });
  }
});

app.post('/api/partners', requireAuth, async (req, res) => {
  const { name, phone, telegram, deal_type, commission_percent, commission_basis, notes, wholesale_payment_timing, wholesale_credit_days, wholesale_penalty_percent_per_day } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Укажите имя партнёра' });
  try {
    const [result] = await pool.query(
      `INSERT INTO partners (name, phone, telegram, deal_type, commission_percent, commission_basis, notes, wholesale_payment_timing, wholesale_credit_days, wholesale_penalty_percent_per_day, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, phone || null, telegram || null, deal_type === 'wholesale' ? 'wholesale' : 'commission', commission_percent || 0, commission_basis === 'net' ? 'net' : 'gross', notes || null, wholesale_payment_timing === 'immediate' ? 'immediate' : 'on_sale', wholesale_credit_days || null, wholesale_penalty_percent_per_day || 0]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка добавления партнёра:', e);
    res.status(500).json({ error: 'Не удалось добавить партнёра' });
  }
});

app.patch('/api/partners/:id', requireAuth, async (req, res) => {
  const allowed = ['name','phone','telegram','deal_type','commission_percent','commission_basis','notes','active','wholesale_payment_timing','wholesale_credit_days','wholesale_penalty_percent_per_day'];
  const body = req.body || {};
  const sets = []; const values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) { sets.push(`${key} = ?`); values.push(key === 'active' ? (body[key]?1:0) : body[key]); }
  }
  if (!sets.length) return res.json({ ok: true });
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE partners SET ${sets.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка изменения партнёра:', e);
    res.status(500).json({ error: 'Не удалось изменить партнёра' });
  }
});

app.delete('/api/partners/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE products SET partner_id = NULL WHERE partner_id = ?', [req.params.id]);
    await pool.query('DELETE FROM partner_expenses WHERE partner_id = ?', [req.params.id]);
    await pool.query('DELETE FROM partner_payouts WHERE partner_id = ?', [req.params.id]);
    await pool.query('DELETE FROM partners WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления партнёра:', e);
    res.status(500).json({ error: 'Не удалось удалить партнёра' });
  }
});

app.post('/api/partners/:id/expenses', requireAuth, async (req, res) => {
  const { title, amount, partner_share_percent } = req.body || {};
  if (!title || !amount) return res.status(400).json({ error: 'Укажите название и сумму' });
  try {
    await pool.query(
      'INSERT INTO partner_expenses (partner_id, title, amount, partner_share_percent) VALUES (?, ?, ?, ?)',
      [req.params.id, title, amount, partner_share_percent ?? 100]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка добавления расхода:', e);
    res.status(500).json({ error: 'Не удалось добавить расход' });
  }
});

app.delete('/api/partner-expenses/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM partner_expenses WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления расхода:', e);
    res.status(500).json({ error: 'Не удалось удалить расход' });
  }
});

app.post('/api/partners/:id/payouts', requireAuth, async (req, res) => {
  const { amount, note } = req.body || {};
  if (!amount) return res.status(400).json({ error: 'Укажите сумму' });
  try {
    await pool.query('INSERT INTO partner_payouts (partner_id, amount, note) VALUES (?, ?, ?)', [req.params.id, amount, note || null]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка записи выплаты:', e);
    res.status(500).json({ error: 'Не удалось записать выплату' });
  }
});

// ----------------------------------------------------------------------------
// ЗАКУПКИ — учёт партий товара (кол-во, цена, поставщик), для расчёта маржи
// ----------------------------------------------------------------------------
app.get('/api/purchases', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM purchases ORDER BY purchase_date DESC, created_at DESC');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка получения закупок:', e);
    res.status(500).json({ error: 'Не удалось получить закупки' });
  }
});

app.post('/api/purchases', requireAuth, async (req, res) => {
  const { product_id, qty, unit_price, purchase_date, supplier, note } = req.body || {};
  if (!product_id || !qty || unit_price == null || !purchase_date) {
    return res.status(400).json({ error: 'Заполните товар, количество, цену и дату' });
  }
  try {
    await pool.query(
      'INSERT INTO purchases (product_id, qty, unit_price, purchase_date, supplier, note) VALUES (?, ?, ?, ?, ?, ?)',
      [product_id, qty, unit_price, purchase_date, supplier || null, note || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка добавления закупки:', e);
    res.status(500).json({ error: 'Не удалось добавить закупку' });
  }
});

app.patch('/api/purchases/:id', requireAuth, async (req, res) => {
  const allowed = ['product_id','qty','unit_price','purchase_date','supplier','note'];
  const body = req.body || {};
  const sets = []; const values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) { sets.push(`${key} = ?`); values.push(body[key]); }
  }
  if (!sets.length) return res.json({ ok: true });
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE purchases SET ${sets.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка изменения закупки:', e);
    res.status(500).json({ error: 'Не удалось изменить закупку' });
  }
});

app.delete('/api/purchases/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM purchases WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления закупки:', e);
    res.status(500).json({ error: 'Не удалось удалить закупку' });
  }
});

// ----------------------------------------------------------------------------
// ФИНАНСЫ — общие расходы + сводные отчёты (ОПиУ и ОДДС)
// ----------------------------------------------------------------------------
app.get('/api/general-expenses', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM general_expenses ORDER BY expense_date DESC, created_at DESC');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка получения расходов:', e);
    res.status(500).json({ error: 'Не удалось получить расходы' });
  }
});

app.post('/api/general-expenses', requireAuth, async (req, res) => {
  const { title, category, subcategory, amount, expense_date, note, payment_method, status, responsible } = req.body || {};
  if (!title || !amount || !expense_date) return res.status(400).json({ error: 'Заполните название, сумму и дату' });
  try {
    await pool.query(
      `INSERT INTO general_expenses (title, category, subcategory, amount, expense_date, note, payment_method, status, responsible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, category || null, subcategory || null, amount, expense_date, note || null,
       ['cash','card','transfer','other'].includes(payment_method) ? payment_method : 'cash',
       status === 'unpaid' ? 'unpaid' : 'paid', responsible || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка добавления расхода:', e);
    res.status(500).json({ error: 'Не удалось добавить расход' });
  }
});

// --- категории расходов (редактируемый справочник, можно добавлять свои) ---
// --- настройки (сейчас только курс USD → смн, для конвертации расхода из Meta Ads) ---
app.get('/api/settings/usd-rate', requireAuth, async (req, res) => {
  try {
    const [[row]] = await pool.query("SELECT value FROM app_settings WHERE `key` = 'usd_to_tjs_rate'");
    res.json({ rate: row ? Number(row.value) : 9.27 });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось получить курс' });
  }
});
app.put('/api/settings/usd-rate', requireAuth, async (req, res) => {
  const rate = Number(req.body && req.body.rate);
  if (!rate || rate <= 0) return res.status(400).json({ error: 'Укажите корректный курс' });
  try {
    await pool.query("INSERT INTO app_settings (`key`, value) VALUES ('usd_to_tjs_rate', ?) ON DUPLICATE KEY UPDATE value = ?", [String(rate), String(rate)]);
    res.json({ ok: true, rate });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось сохранить курс' });
  }
});

app.get('/api/expense-categories', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM expense_categories ORDER BY parent_id IS NULL DESC, parent_id, name');
    const roots = rows.filter(r => !r.parent_id);
    const result = roots.map(r => ({
      id: r.id, name: r.name,
      subcategories: rows.filter(s => s.parent_id === r.id).map(s => ({ id: s.id, name: s.name })),
    }));
    res.json(result);
  } catch (e) {
    console.error('Ошибка получения категорий расходов:', e);
    res.status(500).json({ error: 'Не удалось получить категории' });
  }
});

app.post('/api/expense-categories', requireAuth, async (req, res) => {
  const { name, parent_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Укажите название категории' });
  try {
    const [result] = await pool.query('INSERT INTO expense_categories (name, parent_id) VALUES (?, ?)', [name, parent_id || null]);
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка добавления категории:', e);
    res.status(500).json({ error: 'Не удалось добавить категорию' });
  }
});

app.delete('/api/general-expenses/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM general_expenses WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления расхода:', e);
    res.status(500).json({ error: 'Не удалось удалить расход' });
  }
});

// сводка по финансам: period = today | week | month | all
app.get('/api/owner-transactions', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM owner_transactions ORDER BY transaction_date DESC, created_at DESC');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка получения взносов/изъятий:', e);
    res.status(500).json({ error: 'Не удалось получить данные' });
  }
});

app.post('/api/owner-transactions', requireAuth, async (req, res) => {
  const { type, amount, transaction_date, note } = req.body || {};
  if (!['contribution','withdrawal'].includes(type) || !amount || !transaction_date) {
    return res.status(400).json({ error: 'Заполните тип, сумму и дату' });
  }
  try {
    await pool.query(
      'INSERT INTO owner_transactions (type, amount, transaction_date, note) VALUES (?, ?, ?, ?)',
      [type, amount, transaction_date, note || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка добавления записи:', e);
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

app.delete('/api/owner-transactions/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM owner_transactions WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления записи:', e);
    res.status(500).json({ error: 'Не удалось удалить' });
  }
});

// основной расчёт ОПиУ/ОДДС за произвольный диапазон дат (fromStr/toStr в формате 'YYYY-MM-DD').
// Вынесено в отдельную функцию, чтобы одну и ту же логику можно было посчитать как один раз
// (обычная сводка Финансов), так и много раз подряд — по одному разу на каждый месяц для
// таблицы "показатели по строкам / месяцы по столбцам", как в банковской форме ОПУ.
async function computeFinanceSummaryForRange(fromStr, toStr, periodLabel) {
  const between = (col) => `AND DATE(${col}) BETWEEN '${fromStr}' AND '${toStr}'`;
  const completedCond = `AND DATE(COALESCE(completed_at, created_at)) BETWEEN '${fromStr}' AND '${toStr}'`;

  // выручка — по завершённым заказам (нужен и состав items, чтобы связать с себестоимостью товаров)
  const [orders] = await pool.query(`SELECT id, customer_name, total, refunded_amount, items, created_at, completed_at FROM orders WHERE status = 'done' ${completedCond} ORDER BY created_at DESC`);
  // если по заказу оформлен возврат — вычитаем возвращённую сумму из выручки. При частичном
  // возврате пропорционально уменьшаем и себестоимость этого заказа тем же коэффициентом,
  // чтобы не задваивать и не терять учёт (см. п.26 ТЗ — "не создавать отрицательную прибыль
  // из-за неправильного двойного списания")
  const refundFactor = (o) => {
    const total = Number(o.total) || 0;
    if (total <= 0) return 1;
    const refunded = Number(o.refunded_amount) || 0;
    return Math.max(0, (total - refunded) / total);
  };
  const revenue = orders.reduce((s, o) => s + (Number(o.total) || 0) * refundFactor(o), 0);

  // себестоимость проданных товаров — берём поле "Себестоимость" с самой карточки товара
  const [costRows] = await pool.query('SELECT id, cost_price FROM products');
  const costById = {};
  costRows.forEach(p => { costById[p.id] = Number(p.cost_price) || 0; });
  let cogs = 0;
  for (const o of orders) {
    const factor = refundFactor(o);
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    for (const item of items) {
      cogs += (costById[item.id] || 0) * (Number(item.qty) || 0) * factor;
    }
  }

  // реально потраченные деньги на закупку товара (журнал "Закупки") — для ОДДС
  const [purchaseRows] = await pool.query(
    `SELECT p.id, p.qty, p.unit_price, p.purchase_date, p.supplier, pr.name_ru
     FROM purchases p LEFT JOIN products pr ON pr.id = p.product_id
     WHERE 1=1 ${between('p.purchase_date')} ORDER BY p.purchase_date DESC`
  );
  const purchasesCash = purchaseRows.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.unit_price) || 0), 0);

  // расходы по партнёрам (доля партнёра в расходах) — ручные разовые траты, не комиссия с продажи
  const [partnerExpRows] = await pool.query(
    `SELECT pe.id, pe.title, pe.amount, pe.partner_share_percent, pe.created_at, pt.name AS partner_name
     FROM partner_expenses pe LEFT JOIN partners pt ON pt.id = pe.partner_id
     WHERE 1=1 ${between('pe.created_at')} ORDER BY pe.created_at DESC`
  );
  const partnerExpenses = partnerExpRows.reduce((s, e) => s + (Number(e.amount) || 0) * (Number(e.partner_share_percent) || 0) / 100, 0);

  // комиссия партнёру от факта продажи его товара
  const [partnersAll] = await pool.query('SELECT id, name, commission_percent, commission_basis, deal_type FROM partners');
  const partnersById = {};
  partnersAll.forEach(p => { partnersById[p.id] = p; });
  const [productsForCommission] = await pool.query('SELECT id, partner_id, cost_price FROM products WHERE partner_id IS NOT NULL');
  const productMetaById = {};
  productsForCommission.forEach(p => { productMetaById[p.id] = p; });
  const partnerSalesById = {};
  for (const o of orders) {
    const factor = refundFactor(o);
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    for (const item of items) {
      const prodMeta = productMetaById[item.id];
      if (!prodMeta) continue;
      const partner = partnersById[prodMeta.partner_id];
      if (!partner || partner.deal_type !== 'commission') continue;
      const qty = Number(item.qty) || 0;
      const lineRevenue = (Number(item.price) || 0) * qty * factor;
      const lineMargin = lineRevenue - (Number(prodMeta.cost_price) || 0) * qty * factor;
      if (!partnerSalesById[partner.id]) partnerSalesById[partner.id] = { revenue: 0, margin: 0 };
      partnerSalesById[partner.id].revenue += lineRevenue;
      partnerSalesById[partner.id].margin += lineMargin;
    }
  }

  const [partnerPayoutRows] = await pool.query(
    `SELECT pp.id, pp.amount, pp.note, pp.created_at, pt.name AS partner_name
     FROM partner_payouts pp LEFT JOIN partners pt ON pt.id = pp.partner_id
     WHERE 1=1 ${between('pp.created_at')} ORDER BY pp.created_at DESC`
  );
  const partnerPayouts = partnerPayoutRows.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // зарплата курьерам — начислено (по факту доставок за период) и выплачено
  const [couriers] = await pool.query('SELECT id, first_name, last_name, salary_type, salary_rate FROM couriers');
  let courierSalaryAccrued = 0;
  const courierSalaryRows = [];
  for (const c of couriers) {
    const [[dRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM orders WHERE courier_id = ? AND delivery_status = 'delivered' ${completedCond}`,
      [c.id]
    );
    const deliveries = Number(dRow.cnt) || 0;
    const accrued = c.salary_type === 'fixed' ? Number(c.salary_rate) || 0 : deliveries * (Number(c.salary_rate) || 0);
    if (accrued > 0) {
      courierSalaryRows.push({
        courier_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
        deliveries, salary_type: c.salary_type, salary_rate: c.salary_rate, accrued: round2(accrued),
      });
    }
    courierSalaryAccrued += accrued;
  }
  const [courierPayoutRows] = await pool.query(
    `SELECT cp.id, cp.amount, cp.note, cp.created_at, c.first_name, c.last_name
     FROM courier_payouts cp LEFT JOIN couriers c ON c.id = cp.courier_id
     WHERE 1=1 ${between('cp.created_at')} ORDER BY cp.created_at DESC`
  );
  const courierPayouts = courierPayoutRows.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // общие расходы (аренда, реклама и т.п.) — вручную занесённые
  const [genExpRows] = await pool.query(`SELECT * FROM general_expenses WHERE 1=1 ${between('expense_date')} ORDER BY expense_date DESC`);
  const generalExpenses = genExpRows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const adExpensesManual = genExpRows.filter(e => e.category === 'Реклама').reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // расход на рекламу из Meta Ads Manager — за явный диапазон дат (для отчёта за прошлые месяцы)
  const metaAds = await fetchMetaAdsSpend(periodLabel, fromStr, toStr);
  const adExpensesMeta = metaAds.connected ? Number(metaAds.total_spend) || 0 : 0;
  const adExpenses = adExpensesManual + adExpensesMeta;

  // комиссия каждому партнёру по его базе (gross/net)
  const operatingExpensePool = courierSalaryAccrued + generalExpenses + adExpensesMeta;
  let partnerCommissionAccrued = 0;
  const partnerCommissionRows = [];
  for (const [partnerId, sales] of Object.entries(partnerSalesById)) {
    const partner = partnersById[partnerId];
    const pct = (Number(partner.commission_percent) || 0) / 100;
    let base = sales.margin;
    if (partner.commission_basis === 'net') {
      const expenseShare = revenue > 0 ? (sales.revenue / revenue) * operatingExpensePool : 0;
      base = Math.max(0, sales.margin - expenseShare);
    }
    const commission = base * pct;
    partnerCommissionAccrued += commission;
    partnerCommissionRows.push({
      partner_name: partner.name, basis: partner.commission_basis, revenue: round2(sales.revenue),
      margin: round2(sales.margin), commission: round2(commission),
    });
  }

  const grossProfit = revenue - cogs;
  const totalOperatingExpenses = partnerExpenses + partnerCommissionAccrued + courierSalaryAccrued + generalExpenses + adExpensesMeta;
  const netProfit = grossProfit - totalOperatingExpenses;
  const avgCheck = orders.length ? revenue / orders.length : 0;
  const marketingPct = revenue ? (adExpenses / revenue * 100) : 0;

  const cashIn = revenue;
  const cashOut = purchasesCash + partnerPayouts + courierPayouts + generalExpenses + adExpensesMeta;
  const netCashFlow = cashIn - cashOut;

  return {
    from: fromStr, to: toStr,
    pnl: {
      revenue: round2(revenue),
      cogs: round2(cogs),
      gross_profit: round2(grossProfit),
      partner_expenses: round2(partnerExpenses),
      partner_commission: round2(partnerCommissionAccrued),
      courier_salary: round2(courierSalaryAccrued),
      general_expenses: round2(generalExpenses),
      ad_expenses: round2(adExpenses),
      ad_expenses_manual: round2(adExpensesManual),
      ad_expenses_meta: round2(adExpensesMeta),
      meta_connected: metaAds.connected,
      avg_check: round2(avgCheck),
      marketing_pct: round2(marketingPct),
      margin_pct: revenue ? round2(netProfit / revenue * 100) : 0,
      total_operating_expenses: round2(totalOperatingExpenses),
      net_profit: round2(netProfit),
    },
    cashflow: {
      cash_in: round2(cashIn),
      cogs_paid: round2(purchasesCash),
      partner_payouts: round2(partnerPayouts),
      courier_payouts: round2(courierPayouts),
      general_expenses_paid: round2(generalExpenses),
      ad_expenses_meta: round2(adExpensesMeta),
      cash_out: round2(cashOut),
      net_cash_flow: round2(netCashFlow),
    },
    details: {
      orders,
      purchases: purchaseRows,
      partner_expenses: partnerExpRows,
      partner_commission_by_partner: partnerCommissionRows,
      partner_payouts: partnerPayoutRows,
      courier_salary: courierSalaryRows,
      courier_payouts: courierPayoutRows,
      general_expenses: genExpRows,
    },
  };
}

function resolvePeriodToDates(period) {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  let from;
  if (period === 'today') from = to;
  else if (period === 'week') { const d = new Date(today); d.setDate(d.getDate() - 7); from = d.toISOString().slice(0, 10); }
  else if (period === 'month') { const d = new Date(today); d.setDate(d.getDate() - 30); from = d.toISOString().slice(0, 10); }
  else from = '2000-01-01'; // 'all'
  return { from, to };
}

app.get('/api/finance/summary', requireAuth, async (req, res) => {
  const period = req.query.period || 'all';
  try {
    const { from, to } = resolvePeriodToDates(period);
    const result = await computeFinanceSummaryForRange(from, to, period);
    res.json({ period, ...result });
  } catch (e) {
    console.error('Ошибка расчёта финансовой сводки:', e);
    res.status(500).json({ error: 'Не удалось рассчитать финансы' });
  }
});

// ОПиУ по месяцам одной таблицей — показатели строками, месяцы столбцами (как в банковской
// форме финансового анализа): ?months=6 — последние 6 календарных месяцев, включая текущий
app.get('/api/finance/monthly', requireAuth, async (req, res) => {
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  try {
    const results = [];
    const today = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const isCurrentMonth = (i === 0);
      const from = monthStart.toISOString().slice(0, 10);
      const to = (isCurrentMonth ? today : monthEnd).toISOString().slice(0, 10);
      const label = monthStart.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' });
      const r = await computeFinanceSummaryForRange(from, to, 'month');
      results.push({ label, from, to, pnl: r.pnl });
    }
    res.json({ months: results });
  } catch (e) {
    console.error('Ошибка расчёта помесячного отчёта:', e);
    res.status(500).json({ error: 'Не удалось рассчитать отчёт по месяцам' });
  }
});

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// кэшируем валюту рекламного кабинета на 10 минут — она не меняется часто, незачем
// запрашивать при каждом обновлении страницы Финансов
let adAccountCurrencyCache = null;
let adAccountCurrencyCacheAt = 0;
async function getAdAccountCurrency(token, adAccountId) {
  const now = Date.now();
  if (adAccountCurrencyCache && (now - adAccountCurrencyCacheAt) < 600000) return adAccountCurrencyCache;
  try {
    const res = await fetch(`https://graph.facebook.com/v26.0/${adAccountId}?fields=currency&access_token=${encodeURIComponent(token)}`);
    const data = await res.json();
    adAccountCurrencyCache = data.currency || null;
    adAccountCurrencyCacheAt = now;
  } catch (e) { /* не удалось узнать валюту — просто не будем конвертировать */ }
  return adAccountCurrencyCache;
}

// вынесено в отдельную функцию — используется и отдельной карточкой, и общим расчётом Финансов.
// Если переданы явные даты (fromStr/toStr) — используем их (нужно для отчёта по месяцам за
// прошлые периоды); иначе — обычные пресеты Meta (today/last_7d/last_30d/maximum).
async function fetchMetaAdsSpend(period, fromStr, toStr) {
  const token = process.env.META_ACCESS_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !adAccountId) {
    return { connected: false, message: 'META_ACCESS_TOKEN или META_AD_ACCOUNT_ID не настроены в Railway', total_spend: 0, by_campaign: [] };
  }
  const rangePart = fromStr && toStr
    ? `time_range=${encodeURIComponent(JSON.stringify({ since: fromStr, until: toStr }))}`
    : `date_preset=${period === 'today' ? 'today' : period === 'week' ? 'last_7d' : period === 'month' ? 'last_30d' : 'maximum'}`;
  try {
    const url = `https://graph.facebook.com/v26.0/${adAccountId}/insights?fields=spend,campaign_name&level=campaign&${rangePart}&access_token=${encodeURIComponent(token)}`;
    const metaRes = await fetch(url);
    const data = await metaRes.json();
    if (data.error) {
      console.error('Ошибка Meta Ads API:', data.error);
      return { connected: false, message: data.error.message || 'Ошибка Meta Ads API', total_spend: 0, by_campaign: [] };
    }
    const rows = data.data || [];

    // ВАЖНО: Meta отдаёт "spend" в валюте самого рекламного кабинета (часто это USD),
    // а не автоматически в сомони — если кабинет не в TJS, конвертируем по курсу,
    // который задаётся в настройках (по умолчанию 9.27, можно поменять в админке)
    const currency = await getAdAccountCurrency(token, adAccountId);
    let rate = 1;
    if (currency && currency !== 'TJS') {
      try {
        const [[rateRow]] = await pool.query("SELECT value FROM app_settings WHERE `key` = 'usd_to_tjs_rate'");
        rate = rateRow ? Number(rateRow.value) : 9.27;
      } catch (e) { rate = 9.27; }
    }

    const totalSpendRaw = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0);
    const totalSpend = totalSpendRaw * rate;
    return {
      connected: true, period, total_spend: round2(totalSpend),
      currency: currency || 'TJS', exchange_rate: rate, total_spend_raw: round2(totalSpendRaw),
      by_campaign: rows.map(r => ({ name: r.campaign_name, spend: round2((Number(r.spend) || 0) * rate) })),
    };
  } catch (e) {
    console.error('Ошибка запроса к Meta Ads API:', e);
    return { connected: false, message: 'Не удалось связаться с Meta Ads API', total_spend: 0, by_campaign: [] };
  }
}

// --- реальный расход на рекламу из Meta Ads Manager (Marketing API) ---
// требует переменные окружения META_ACCESS_TOKEN и META_AD_ACCOUNT_ID (см. Railway → Variables)
app.get('/api/finance/meta-ads-spend', requireAuth, async (req, res) => {
  const result = await fetchMetaAdsSpend(req.query.period || 'today');
  res.status(200).json(result);
});

// баланс — снимок на сегодня (не за период, как ОПиУ/ОДДС, а состояние прямо сейчас)
app.get('/api/finance/balance', requireAuth, async (req, res) => {
  try {
    // --- касса: весь денежный поток с самого начала ---
    const [[doneOrdersRow]] = await pool.query("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status = 'done'");
    const revenueAll = Number(doneOrdersRow.total) || 0;

    const [[purchAllRow]] = await pool.query('SELECT COALESCE(SUM(qty * unit_price), 0) AS total FROM purchases');
    const cogsAll = Number(purchAllRow.total) || 0;

    const [[partnerPayoutAllRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM partner_payouts');
    const partnerPayoutsAll = Number(partnerPayoutAllRow.total) || 0;

    const [[courierPayoutAllRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM courier_payouts');
    const courierPayoutsAll = Number(courierPayoutAllRow.total) || 0;

    const [[genExpAllRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM general_expenses');
    const generalExpensesAll = Number(genExpAllRow.total) || 0;

    const [[contribRow]] = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM owner_transactions WHERE type = 'contribution'");
    const [[withdrawRow]] = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM owner_transactions WHERE type = 'withdrawal'");
    const ownerContributions = Number(contribRow.total) || 0;
    const ownerWithdrawals = Number(withdrawRow.total) || 0;

    const cash = revenueAll - cogsAll - partnerPayoutsAll - courierPayoutsAll - generalExpensesAll + ownerContributions - ownerWithdrawals;

    // --- товар на складе (по себестоимости) ---
    const [products] = await pool.query('SELECT stock, cost_price FROM products WHERE stock IS NOT NULL AND cost_price IS NOT NULL');
    const inventoryValue = products.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.cost_price) || 0), 0);

    // --- дебиторка: заказы уже в пути (товар отдан курьеру), но ещё не подтверждены как доставленные ---
    const [[receivableRow]] = await pool.query(
      "SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status = 'progress' AND delivery_status = 'in_transit'"
    );
    const receivables = Number(receivableRow.total) || 0;

    // --- обязательства: сколько должны партнёрам и курьерам прямо сейчас (только положительный остаток) ---
    const [partners] = await pool.query('SELECT * FROM partners');
    let payableToPartners = 0;
    const payableToPartnersBreakdown = [];
    for (const p of partners) {
      const stats = await computePartnerStats(p.id, p, false);
      if (stats.balance_due > 0) {
        payableToPartners += stats.balance_due;
        payableToPartnersBreakdown.push({ id: p.id, name: p.name, amount: round2(stats.balance_due) });
      }
    }

    const [couriers] = await pool.query('SELECT * FROM couriers');
    let payableToCouriers = 0;
    const payableToCouriersBreakdown = [];
    for (const c of couriers) {
      const [[dRow]] = await pool.query("SELECT COUNT(*) AS cnt FROM orders WHERE courier_id = ? AND delivery_status = 'delivered'", [c.id]);
      const deliveries = Number(dRow.cnt) || 0;
      const accrued = c.salary_type === 'fixed' ? Number(c.salary_rate) || 0 : deliveries * (Number(c.salary_rate) || 0);
      const [[paidRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM courier_payouts WHERE courier_id = ?', [c.id]);
      const balanceDue = accrued - (Number(paidRow.total) || 0);
      if (balanceDue > 0) {
        payableToCouriers += balanceDue;
        payableToCouriersBreakdown.push({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' '), amount: round2(balanceDue) });
      }
    }

    const assets = cash + inventoryValue + receivables;
    const liabilities = payableToPartners + payableToCouriers;

    // накопленная прибыль с начала — считаем упрощённо как выручка минус все расходы за всё время
    // (расходы партнёров начисленным методом, зарплата курьеров начисленным методом)
    const [[partnerExpAllRow]] = await pool.query('SELECT COALESCE(SUM(amount * partner_share_percent / 100), 0) AS total FROM partner_expenses');
    const partnerExpensesAll = Number(partnerExpAllRow.total) || 0;
    let courierSalaryAll = 0;
    for (const c of couriers) {
      const [[dRow]] = await pool.query("SELECT COUNT(*) AS cnt FROM orders WHERE courier_id = ? AND delivery_status = 'delivered'", [c.id]);
      const deliveries = Number(dRow.cnt) || 0;
      courierSalaryAll += c.salary_type === 'fixed' ? Number(c.salary_rate) || 0 : deliveries * (Number(c.salary_rate) || 0);
    }
    const retainedEarnings = revenueAll - cogsAll - partnerExpensesAll - courierSalaryAll - generalExpensesAll;
    const equity = (ownerContributions - ownerWithdrawals) + retainedEarnings;

    res.json({
      assets: {
        cash: round2(cash),
        inventory_value: round2(inventoryValue),
        receivables: round2(receivables),
        total: round2(assets),
      },
      liabilities: {
        payable_to_partners: round2(payableToPartners),
        payable_to_partners_breakdown: payableToPartnersBreakdown,
        payable_to_couriers: round2(payableToCouriers),
        payable_to_couriers_breakdown: payableToCouriersBreakdown,
        total: round2(liabilities),
      },
      equity: {
        owner_net: round2(ownerContributions - ownerWithdrawals),
        retained_earnings: round2(retainedEarnings),
        total: round2(equity),
      },
      check_diff: round2(assets - (liabilities + equity)),
    });
  } catch (e) {
    console.error('Ошибка расчёта баланса:', e);
    res.status(500).json({ error: 'Не удалось рассчитать баланс' });
  }
});

// ----------------------------------------------------------------------------
// ТОВАРЫ — публичный список (для сайта) + CRUD только для администратора
// ----------------------------------------------------------------------------
app.get('/api/products', async (req, res) => {
  try {
    const showAll = req.query.all === '1'; // ?all=1 — для админки (показывает и скрытые товары)
    const [rows] = await pool.query(
      showAll
        ? 'SELECT * FROM products ORDER BY sort_order ASC, id ASC'
        : 'SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, id ASC'
    );

    // считаем, сколько раз каждый товар встречался в заказах (по id товара в items)
    const [orderRows] = await pool.query('SELECT items FROM orders');
    const salesById = {};
    for (const o of orderRows) {
      let items = o.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (e) { items = []; }
      }
      if (Array.isArray(items)) {
        for (const it of items) {
          if (it && it.id != null) {
            salesById[it.id] = (salesById[it.id] || 0) + (Number(it.qty) || 0);
          }
        }
      }
    }

    // фото/видео моделей (худая/полная, по цветам) — для всех товаров разом
    const [mediaRows] = await pool.query('SELECT * FROM product_model_media ORDER BY id ASC');
    const mediaByProduct = {};
    for (const m of mediaRows) {
      (mediaByProduct[m.product_id] = mediaByProduct[m.product_id] || []).push({
        id: m.id, color: m.color, body_type: m.body_type,
        media_type: m.media_type, media_data: m.media_data
      });
    }

    const products = rows.map(r => ({
      ...r,
      extra_images: typeof r.extra_images === 'string' ? JSON.parse(r.extra_images) : (r.extra_images || []),
      sales: salesById[r.id] || 0,
      model_media: mediaByProduct[r.id] || []
    }));
    res.json(products);
  } catch (e) {
    console.error('Ошибка получения товаров:', e);
    res.status(500).json({ error: 'Не удалось получить товары' });
  }
});

// админ — включить/выключить показ товара на сайте (не удаляя его)
app.patch('/api/products/:id/active', requireAuth, async (req, res) => {
  const { active } = req.body || {};
  try {
    await pool.query('UPDATE products SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка изменения активности товара:', e);
    res.status(500).json({ error: 'Не удалось изменить статус товара' });
  }
});

// публичный — увеличивает счётчик просмотров на 1 (вызывается при открытии страницы товара)
app.post('/api/products/:id/view', async (req, res) => {
  try {
    const { visitor_id, utm_source } = req.body || {};
    await pool.query('UPDATE products SET views = views + 1 WHERE id = ?', [req.params.id]);
    pool.query(
      'INSERT INTO funnel_events (event_type, product_id, visitor_id, utm_source) VALUES (?, ?, ?, ?)',
      ['view', req.params.id, visitor_id || null, utm_source || null]
    ).catch(()=>{});
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка увеличения счётчика просмотров:', e);
    res.status(500).json({ error: 'Не удалось обновить просмотры' });
  }
});

// публичный — событие воронки продаж: добавление в корзину / начало оформления (для "Воронка продаж")
app.post('/api/track-event', async (req, res) => {
  const { type, product_id, visitor_id, utm_source } = req.body || {};
  if (!['cart', 'checkout'].includes(type)) return res.status(400).json({ error: 'Неизвестный тип события' });
  try {
    await pool.query(
      'INSERT INTO funnel_events (event_type, product_id, visitor_id, utm_source) VALUES (?, ?, ?, ?)',
      [type, product_id || null, visitor_id || null, utm_source || null]
    );
    res.json({ ok: true });
  } catch (e) {
    // событие воронки не критично — не должно ломать пользовательский опыт
    res.json({ ok: false });
  }
});

app.post('/api/products', requireAuth, async (req, res) => {
  const {
    cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj,
    image_data, subtitle_ru, subtitle_tj,
    bundle2_price, bundle3_price, bundle4_price,
    features_ru, features_tj, delivery_ru, delivery_tj, warranty_ru, warranty_tj,
    cost_price, stock, rating, rating_count, colors, sizes,
    extra_images, seller_name, partner_id, received_at
  } = req.body || {};
  if (!cat || !name_ru || !name_tj || price == null) {
    return res.status(400).json({ error: 'Не хватает обязательных полей товара' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO products (
        cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj,
        image_data, subtitle_ru, subtitle_tj,
        bundle2_price, bundle3_price, bundle4_price,
        features_ru, features_tj, delivery_ru, delivery_tj, warranty_ru, warranty_tj,
        cost_price, stock, rating, rating_count, colors, sizes,
        extra_images, seller_name, partner_id, received_at
      ) VALUES (?,?,?,?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?, ?,?,?,?)`,
      [
        cat, name_ru, name_tj, price, old_price || null, emoji || '🛍️', tag || null, desc_ru || '', desc_tj || '',
        image_data || null, subtitle_ru || null, subtitle_tj || null,
        bundle2_price || null, bundle3_price || null, bundle4_price || null,
        features_ru || null, features_tj || null, delivery_ru || null, delivery_tj || null, warranty_ru || null, warranty_tj || null,
        cost_price || null, stock == null ? null : stock, rating || null, rating_count || null,
        colors || null, sizes || null,
        (Array.isArray(extra_images) && extra_images.length) ? JSON.stringify(extra_images) : null,
        seller_name || null, partner_id || null, received_at || null
      ]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка создания товара:', e);
    res.status(500).json({ error: 'Не удалось создать товар' });
  }
});

app.put('/api/products/:id', requireAuth, async (req, res) => {
  const {
    cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj,
    image_data, subtitle_ru, subtitle_tj,
    bundle2_price, bundle3_price, bundle4_price,
    features_ru, features_tj, delivery_ru, delivery_tj, warranty_ru, warranty_tj,
    cost_price, stock, rating, rating_count, colors, sizes,
    extra_images, seller_name, partner_id, received_at
  } = req.body || {};
  if (!cat || !name_ru || !name_tj || price == null) {
    return res.status(400).json({ error: 'Не хватает обязательных полей товара' });
  }
  try {
    await pool.query(
      `UPDATE products SET
        cat=?, name_ru=?, name_tj=?, price=?, old_price=?, emoji=?, tag=?, desc_ru=?, desc_tj=?,
        image_data=?, subtitle_ru=?, subtitle_tj=?,
        bundle2_price=?, bundle3_price=?, bundle4_price=?,
        features_ru=?, features_tj=?, delivery_ru=?, delivery_tj=?, warranty_ru=?, warranty_tj=?,
        cost_price=?, stock=?, rating=?, rating_count=?, colors=?, sizes=?,
        extra_images=?, seller_name=?, partner_id=?, received_at=?
       WHERE id=?`,
      [
        cat, name_ru, name_tj, price, old_price || null, emoji || '🛍️', tag || null, desc_ru || '', desc_tj || '',
        image_data || null, subtitle_ru || null, subtitle_tj || null,
        bundle2_price || null, bundle3_price || null, bundle4_price || null,
        features_ru || null, features_tj || null, delivery_ru || null, delivery_tj || null, warranty_ru || null, warranty_tj || null,
        cost_price || null, stock == null ? null : stock, rating || null, rating_count || null,
        colors || null, sizes || null,
        (Array.isArray(extra_images) && extra_images.length) ? JSON.stringify(extra_images) : null,
        seller_name || null, partner_id || null, received_at || null,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка обновления товара:', e);
    res.status(500).json({ error: 'Не удалось обновить товар' });
  }
});

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления товара:', e);
    res.status(500).json({ error: 'Не удалось удалить товар' });
  }
});

// ----------------------------------------------------------------------------
// МЕДИА МОДЕЛИ — фото/видео товара на модели (худая/полная), по цветам.
// Переключается на странице товара при выборе цвета/размера.
// ----------------------------------------------------------------------------
app.post('/api/products/:id/model-media', requireAuth, async (req, res) => {
  const { color, body_type, media_type, media_data } = req.body || {};
  if (!body_type || !media_data) {
    return res.status(400).json({ error: 'Не хватает данных (тип фигуры или файл)' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO product_model_media (product_id, color, body_type, media_type, media_data)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, color || null, body_type, media_type || 'video', media_data]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка добавления медиа модели:', e);
    res.status(500).json({ error: 'Не удалось сохранить фото/видео модели' });
  }
});

app.delete('/api/model-media/:mediaId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM product_model_media WHERE id = ?', [req.params.mediaId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления медиа модели:', e);
    res.status(500).json({ error: 'Не удалось удалить фото/видео модели' });
  }
});

// ----------------------------------------------------------------------------
// ТЕЛЕГРАМ-БОТ ДЛЯ КУРЬЕРОВ
// ----------------------------------------------------------------------------
async function tgCall(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN не задан — бот для курьеров не работает.');
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    console.error(`Ошибка запроса к Telegram (${method}):`, e);
    return null;
  }
}

// ----------------------------------------------------------------------------
// ЕЖЕДНЕВНАЯ СВОДКА ВЛАДЕЛЬЦУ В TELEGRAM — "мёртвый" товар и клиенты, которым
// пора напомнить о себе (см. раздел Аналитика в админке)
// ----------------------------------------------------------------------------
async function computeDailyDigestData() {
  // мёртвый товар: остаток есть, но 0 продаж за последние 30 дней
  const [products] = await pool.query("SELECT id, name_ru, stock FROM products WHERE active = 1 AND stock IS NOT NULL AND stock > 0");
  const [recentOrders] = await pool.query(
    "SELECT items FROM orders WHERE status = 'done' AND COALESCE(completed_at, created_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
  );
  const soldRecently = new Set();
  for (const o of recentOrders) {
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    for (const it of items) { if ((Number(it.qty) || 0) > 0) soldRecently.add(String(it.id)); }
  }
  const deadStock = products.filter(p => !soldRecently.has(String(p.id))).slice(0, 8);

  // клиенты, которые давно не покупали (>60 дней), топ по сумме покупок за всё время
  const [allDone] = await pool.query(
    "SELECT customer_name, customer_phone, total, COALESCE(completed_at, created_at) AS done_at FROM orders WHERE status = 'done'"
  );
  const custMap = {};
  for (const o of allDone) {
    const phone = (o.customer_phone || '').replace(/\D/g, '');
    if (!phone) continue;
    if (!custMap[phone]) custMap[phone] = { name: o.customer_name, phone, total: 0, lastDate: null };
    custMap[phone].total += Number(o.total) || 0;
    const d = new Date(o.done_at);
    if (!custMap[phone].lastDate || d > custMap[phone].lastDate) custMap[phone].lastDate = d;
  }
  const now = new Date();
  const dormant = Object.values(custMap)
    .map(c => ({ ...c, recency_days: c.lastDate ? Math.floor((now - c.lastDate) / 86400000) : 9999 }))
    .filter(c => c.recency_days > 60)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return { deadStock, dormant };
}

function buildDigestMessage({ deadStock, dormant }) {
  const lines = [`📊 <b>Ежедневная сводка · ХАМАБОЗОР</b>\n`];
  lines.push(`📦 <b>Мёртвый товар</b> (остаток есть, продаж не было 30+ дней):`);
  if (deadStock.length) {
    deadStock.forEach(p => lines.push(`• ${p.name_ru} — остаток ${p.stock} шт`));
  } else {
    lines.push('Нет — все товары, что в наличии, продаются.');
  }
  lines.push('');
  lines.push(`👥 <b>Клиенты, которым пора напомнить о себе</b> (не покупали 60+ дней):`);
  if (dormant.length) {
    dormant.forEach(c => lines.push(`• ${c.name} · ${c.phone} — ${round2(c.total)} смн всего, ${c.recency_days} дн. назад`));
  } else {
    lines.push('Нет — все постоянные клиенты покупали недавно.');
  }
  return lines.join('\n');
}

async function sendDailyDigest() {
  if (!OWNER_TELEGRAM_CHAT_ID) {
    console.warn('⚠️  OWNER_TELEGRAM_CHAT_ID не задан — ежедневная сводка не отправляется. См. README-DATABASE.md.');
    return;
  }
  try {
    const data = await computeDailyDigestData();
    const text = buildDigestMessage(data);
    await tgCall('sendMessage', { chat_id: OWNER_TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    console.log('Ежедневная сводка отправлена в Telegram');
  } catch (e) {
    console.error('Ошибка отправки ежедневной сводки:', e);
  }
}

// проверяем раз в 15 минут, не настал ли час отправки сводки (защита от повторной отправки в тот же день)
let lastDigestSentDate = null;
function scheduleDailyDigest() {
  setInterval(() => {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    if (now.getHours() === DIGEST_HOUR && lastDigestSentDate !== todayKey) {
      lastDigestSentDate = todayKey;
      sendDailyDigest();
    }
  }, 15 * 60 * 1000);
}

function buildOrderMessage(order, extraLine) {
  const items = (typeof order.items === 'string' ? JSON.parse(order.items) : order.items) || [];
  const itemsText = items.map(i => `• ${i.name} ×${i.qty}`).join('\n');
  return (
    `📦 <b>Заказ #${order.id}</b>\n\n` +
    `${itemsText}\n\n` +
    `👤 ${order.customer_name}\n` +
    `📞 ${order.customer_phone}\n` +
    (order.customer_address ? `📍 Адрес: ${order.customer_address}\n` : '') +
    (order.comment ? `🧭 Ориентир/комментарий: ${order.comment}\n` : '') +
    `💰 Итого: ${order.total} смн` +
    (extraLine ? `\n\n${extraLine}` : '')
  );
}

// рассылает заказ всем подтверждённым курьерам с кнопкой "Принять заказ"
async function broadcastOrderToCouriers(orderId) {
  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return;
  const [couriers] = await pool.query('SELECT * FROM couriers WHERE active = 1');
  if (!couriers.length) {
    console.warn('⚠️  Нет активных курьеров — заказ #' + orderId + ' некому отправить.');
    return;
  }
  const text = buildOrderMessage(order);
  const keyboard = { inline_keyboard: [[{ text: '✅ Принять заказ', callback_data: `accept_${order.id}` }]] };
  const broadcast = [];
  for (const c of couriers) {
    const result = await tgCall('sendMessage', {
      chat_id: c.telegram_chat_id, text, parse_mode: 'HTML', reply_markup: keyboard,
    });
    if (result && result.ok) {
      broadcast.push({ chat_id: c.telegram_chat_id, message_id: result.result.message_id });
    }
  }
  await pool.query('UPDATE orders SET telegram_broadcast = ? WHERE id = ?', [JSON.stringify(broadcast), order.id]);
}

function normalizePhone(p) {
  return (p || '').replace(/\D/g, '').slice(-9); // последние 9 цифр — для сравнения номеров
}

// рассылает произвольный текст всем подключённым (привязанным) курьерам
async function broadcastMessageToCouriers(text) {
  const [couriers] = await pool.query('SELECT * FROM couriers WHERE telegram_chat_id IS NOT NULL AND active = 1');
  for (const c of couriers) {
    await tgCall('sendMessage', { chat_id: c.telegram_chat_id, text });
  }
  return couriers.length;
}

// вебхук — сюда Telegram присылает все обновления (сообщения и нажатия кнопок)
app.post('/api/telegram/webhook/:token', async (req, res) => {
  if (req.params.token !== TELEGRAM_BOT_TOKEN) return res.sendStatus(403);
  res.sendStatus(200); // отвечаем сразу, дальше обрабатываем в фоне

  try {
    const update = req.body;

    // курьер написал /start — просим номер телефона, чтобы привязать к записи, которую создал админ
    if (update.message && update.message.text === '/start') {
      const chat = update.message.chat;
      const [[existing]] = await pool.query('SELECT * FROM couriers WHERE telegram_chat_id = ?', [chat.id]);
      if (existing) {
        await tgCall('sendMessage', {
          chat_id: chat.id,
          text: `✅ Шумо аллакай ҳамчун курьер васл шудед: ${existing.first_name || ''} ${existing.last_name || ''}`.trim(),
        });
      } else {
        await tgCall('sendMessage', {
          chat_id: chat.id,
          text: 'Салом! Барои пайваст шудан ҳамчун курьер, рақами телефони худро фиристед 👇\n\n(Привет! Чтобы подключиться как курьер, отправьте свой номер телефона кнопкой ниже.)',
          reply_markup: {
            keyboard: [[{ text: '📱 Фиристодани рақами телефон', request_contact: true }]],
            resize_keyboard: true, one_time_keyboard: true,
          },
        });
      }
      return;
    }

    // курьер поделился номером телефона — ищем его среди курьеров, добавленных админом
    if (update.message && update.message.contact) {
      const chat = update.message.chat;
      const phone = normalizePhone(update.message.contact.phone_number);
      const [rows] = await pool.query('SELECT * FROM couriers WHERE telegram_chat_id IS NULL');
      const match = rows.find(c => normalizePhone(c.phone) === phone || normalizePhone(c.phone2) === phone);
      if (match) {
        await pool.query(
          'UPDATE couriers SET telegram_chat_id = ?, username = ? WHERE id = ?',
          [chat.id, chat.username || null, match.id]
        );
        await tgCall('sendMessage', {
          chat_id: chat.id,
          text: `✅ Хуш омадед, ${match.first_name || ''} ${match.last_name || ''}! Шумо ҳамчун курьер пайваст шудед. Фармоишҳо дар ин ҷо пайдо мешаванд.`.trim(),
          reply_markup: { remove_keyboard: true },
        });
      } else {
        await tgCall('sendMessage', {
          chat_id: chat.id,
          text: 'Рақами шумо дар рӯйхати курьерон ёфт нашуд. Лутфан ба администратор муроҷиат кунед, то шуморо илова кунад.',
          reply_markup: { remove_keyboard: true },
        });
      }
      return;
    }

    // курьер нажал одну из кнопок
    if (update.callback_query) {
      const cq = update.callback_query;
      const [action, orderIdStr] = cq.data.split('_');
      const orderId = Number(orderIdStr);
      const [[courier]] = await pool.query('SELECT * FROM couriers WHERE telegram_chat_id = ?', [cq.from.id]);
      const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      if (!courier || !order) {
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'Хатогӣ — фармоиш ёфт нашуд.' });
        return;
      }

      if (action === 'accept') {
        if (order.courier_id) {
          await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'Ин фармоиш аллакай гирифта шудааст.', show_alert: true });
          return;
        }
        // курьер сразу считается "в пути" — отдельного шага "принял" в статусах не показываем
        await pool.query('UPDATE orders SET courier_id = ?, delivery_status = ? WHERE id = ?', [courier.id, 'in_transit', orderId]);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'Фармоиш гирифта шуд! ✅' });

        const broadcast = typeof order.telegram_broadcast === 'string' ? JSON.parse(order.telegram_broadcast) : (order.telegram_broadcast || []);
        for (const b of broadcast) {
          if (b.chat_id === cq.from.id) {
            await tgCall('editMessageText', {
              chat_id: b.chat_id, message_id: b.message_id, parse_mode: 'HTML',
              text: buildOrderMessage(order, '✅ Шумо ин фармоишро гирифтед. Дар роҳ ҳастед 🚚'),
              reply_markup: { inline_keyboard: [[{ text: '📦 Расонида шуд (доставлено)', callback_data: `delivered_${orderId}` }]] },
            });
          } else {
            await tgCall('editMessageText', {
              chat_id: b.chat_id, message_id: b.message_id, parse_mode: 'HTML',
              text: buildOrderMessage(order, '🚫 Ин фармоишро курьери дигар гирифт.'),
            });
          }
        }
      }

      if (action === 'delivered') {
        if (order.courier_id !== courier.id) {
          await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'Ин фармоиши шумо нест.' });
          return;
        }
        await pool.query('UPDATE orders SET delivery_status = ?, status = ? WHERE id = ?', ['delivered', 'done', orderId]);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: 'Раҳмат! Фармоиш анҷом ёфт ✅' });
        await tgCall('editMessageText', {
          chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML',
          text: buildOrderMessage(order, '✅ Расонида шуд.'),
        });
      }
    }
  } catch (e) {
    console.error('Ошибка обработки Telegram webhook:', e);
  }
});

// одноразовая настройка — подключает вебхук бота к этому серверу (нажимается в админке)
app.post('/api/telegram/set-webhook', requireAuth, async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN не задан в настройках Railway' });
  const url = `https://${req.get('host')}/api/telegram/webhook/${TELEGRAM_BOT_TOKEN}`;
  const result = await tgCall('setWebhook', { url });
  if (result && result.ok) res.json({ ok: true, url });
  else res.status(500).json({ error: 'Telegram отклонил запрос', details: result });
});

// список курьеров (для админки)
app.get('/api/couriers', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM orders o WHERE o.courier_id = c.id AND o.delivery_status = 'delivered') AS deliveries_count,
        (SELECT COALESCE(SUM(amount), 0) FROM courier_payouts cp WHERE cp.courier_id = c.id) AS paid_total
      FROM couriers c
      ORDER BY c.active DESC, c.created_at DESC
    `);
    const withSalary = rows.map(c => {
      const deliveries = Number(c.deliveries_count) || 0;
      const salaryDue = c.salary_type === 'fixed' ? Number(c.salary_rate) || 0 : deliveries * (Number(c.salary_rate) || 0);
      const paidTotal = Number(c.paid_total) || 0;
      return { ...c, salary_due: Math.round(salaryDue * 100) / 100, balance_due: Math.round((salaryDue - paidTotal) * 100) / 100 };
    });
    res.json(withSalary);
  } catch (e) {
    console.error('Ошибка получения курьеров:', e);
    res.status(500).json({ error: 'Не удалось получить курьеров' });
  }
});

// записать выплату зарплаты курьеру
app.post('/api/couriers/:id/payouts', requireAuth, async (req, res) => {
  const { amount, note } = req.body || {};
  if (!amount) return res.status(400).json({ error: 'Укажите сумму' });
  try {
    await pool.query('INSERT INTO courier_payouts (courier_id, amount, note) VALUES (?, ?, ?)', [req.params.id, amount, note || null]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка записи выплаты курьеру:', e);
    res.status(500).json({ error: 'Не удалось записать выплату' });
  }
});

// добавить курьера вручную (админ заполняет все данные заранее)
app.post('/api/couriers', requireAuth, async (req, res) => {
  const { first_name, last_name, phone, phone2, vehicle_type, vehicle_number, inn, passport_number, address, username, salary_type, salary_rate } = req.body || {};
  if (!first_name || !phone) {
    return res.status(400).json({ error: 'Укажите хотя бы имя и телефон' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO couriers (first_name, last_name, phone, phone2, vehicle_type, vehicle_number, inn, passport_number, address, username, salary_type, salary_rate, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [first_name, last_name || null, phone, phone2 || null, vehicle_type || null, vehicle_number || null, inn || null, passport_number || null, address || null, (username || '').replace(/^@/, '') || null, salary_type === 'fixed' ? 'fixed' : 'per_delivery', salary_rate || 0]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка добавления курьера:', e);
    res.status(500).json({ error: 'Не удалось добавить курьера' });
  }
});

// изменить данные курьера / подтвердить-отключить
app.patch('/api/couriers/:id', requireAuth, async (req, res) => {
  const allowed = ['first_name','last_name','phone','phone2','vehicle_type','vehicle_number','inn','passport_number','address','username','active','display_name','salary_type','salary_rate'];
  const body = req.body || {};
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(key === 'active' ? (body[key] ? 1 : 0) : body[key]);
    }
  }
  if (!sets.length) return res.json({ ok: true });
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE couriers SET ${sets.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка изменения курьера:', e);
    res.status(500).json({ error: 'Не удалось изменить курьера' });
  }
});

// удалить курьера
app.delete('/api/couriers/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE orders SET courier_id = NULL WHERE courier_id = ?', [req.params.id]);
    await pool.query('DELETE FROM couriers WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления курьера:', e);
    res.status(500).json({ error: 'Не удалось удалить курьера' });
  }
});

// разослать сообщение всем подключённым курьерам (для модераторов/админа)
app.post('/api/couriers/broadcast', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Пустое сообщение' });
  try {
    const count = await broadcastMessageToCouriers(text.trim());
    res.json({ ok: true, count });
  } catch (e) {
    console.error('Ошибка рассылки курьерам:', e);
    res.status(500).json({ error: 'Не удалось разослать сообщение' });
  }
});


// ----------------------------------------------------------------------------
// добавляет колонку в таблицу, если её ещё нет — безопасно для уже
// работающей базы (например, на Railway), не только для новых установок
// ----------------------------------------------------------------------------
async function ensureColumn(table, column, definitionSql) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (rows[0].cnt === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definitionSql}`);
    console.log(`Добавлена колонка ${table}.${column}`);
  }
}

async function ensurePurchasesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      product_id     INT NOT NULL,
      qty            INT NOT NULL,
      unit_price     DECIMAL(10,2) NOT NULL,
      purchase_date  DATE NOT NULL,
      supplier       VARCHAR(255),
      note           VARCHAR(255),
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_purchases_product (product_id)
    )
  `);
}

async function ensureHrTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id                      INT AUTO_INCREMENT PRIMARY KEY,
      first_name              VARCHAR(255) NOT NULL,
      last_name               VARCHAR(255),
      middle_name             VARCHAR(255),
      photo                   LONGTEXT,
      position                VARCHAR(255),
      department              VARCHAR(255),
      birth_date              DATE NULL,
      email                   VARCHAR(255),
      phone                   VARCHAR(50),
      passport_series         VARCHAR(50),
      social_insurance_number VARCHAR(50),
      inn                     VARCHAR(50),
      hire_date               DATE NULL,
      active                  TINYINT(1) NOT NULL DEFAULT 1,
      notes                   TEXT,
      created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_contacts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT NOT NULL,
      label        VARCHAR(100),
      phone        VARCHAR(50),
      INDEX idx_ec_emp (employee_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_lateness (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT NOT NULL,
      date         DATE NOT NULL,
      minutes      INT NOT NULL DEFAULT 0,
      note         VARCHAR(255),
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_el_emp (employee_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_contracts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT NOT NULL,
      title        VARCHAR(255) NOT NULL,
      start_date   DATE,
      end_date     DATE NULL,
      note         VARCHAR(255),
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ect_emp (employee_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_vacations (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT NOT NULL,
      start_date   DATE NOT NULL,
      end_date     DATE NOT NULL,
      type         VARCHAR(50) DEFAULT 'Оплачиваемый',
      note         VARCHAR(255),
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ev_emp (employee_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_advances (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT NOT NULL,
      date         DATE NOT NULL,
      amount       DECIMAL(10,2) NOT NULL,
      note         VARCHAR(255),
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ea_emp (employee_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_assets (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      employee_id    INT NOT NULL,
      item_name      VARCHAR(255) NOT NULL,
      serial_number  VARCHAR(255),
      issue_date     DATE,
      return_date    DATE NULL,
      note           VARCHAR(255),
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_eas_emp (employee_id)
    )
  `);
}

async function ensureVisitsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_visits (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_visits_date (created_at)
    )
  `);
  await ensureColumn('site_visits', 'visitor_id', 'VARCHAR(64) NULL');
  await ensureColumn('site_visits', 'utm_source', 'VARCHAR(100) NULL');
  await pool.query('ALTER TABLE site_visits ADD INDEX idx_visits_visitor (visitor_id)').catch(()=>{});

  // события воронки продаж: просмотр товара / добавление в корзину / начало оформления —
  // нужны для раздела "Аналитика → Воронка продаж", чтобы видеть, где отваливаются клиенты
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funnel_events (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      event_type   ENUM('view','cart','checkout') NOT NULL,
      product_id   INT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_funnel_type_date (event_type, created_at)
    )
  `);
  await ensureColumn('funnel_events', 'visitor_id', 'VARCHAR(64) NULL');
  await ensureColumn('funnel_events', 'utm_source', 'VARCHAR(100) NULL');
}

async function ensureMarketingTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      code            VARCHAR(50) NOT NULL UNIQUE,
      discount_type   ENUM('percent','fixed') NOT NULL DEFAULT 'percent',
      discount_value  DECIMAL(10,2) NOT NULL,
      usage_limit     INT NULL,
      expires_at      DATE NULL,
      active          TINYINT(1) NOT NULL DEFAULT 1,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      name            VARCHAR(255) NOT NULL,
      platform        VARCHAR(100),
      budget          DECIMAL(10,2) NOT NULL DEFAULT 0,
      start_date      DATE,
      end_date        DATE NULL,
      promo_code_id   INT NULL,
      note            VARCHAR(255),
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bloggers (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      name            VARCHAR(255) NOT NULL,
      platform        VARCHAR(100),
      phone           VARCHAR(50),
      telegram        VARCHAR(255),
      deal_type       ENUM('fixed','percent') NOT NULL DEFAULT 'fixed',
      fee_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
      promo_code_id   INT NULL,
      notes           TEXT,
      active          TINYINT(1) NOT NULL DEFAULT 1,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn('orders', 'promo_code', 'VARCHAR(50) NULL');
  await ensureColumn('orders', 'discount_amount', 'DECIMAL(10,2) NULL');
  await ensureColumn('orders', 'utm_source', 'VARCHAR(100) NULL');
  await ensureColumn('orders', 'utm_medium', 'VARCHAR(100) NULL');
  await ensureColumn('orders', 'utm_campaign', 'VARCHAR(150) NULL');
}

async function ensureFinanceTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS general_expenses (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      title          VARCHAR(255) NOT NULL,
      category       VARCHAR(100),
      amount         DECIMAL(10,2) NOT NULL,
      expense_date   DATE NOT NULL,
      note           VARCHAR(255),
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn('general_expenses', 'subcategory', 'VARCHAR(100) NULL');
  await ensureColumn('general_expenses', 'payment_method', "ENUM('cash','card','transfer','other') NOT NULL DEFAULT 'cash'");
  await ensureColumn('general_expenses', 'status', "ENUM('paid','unpaid') NOT NULL DEFAULT 'paid'");
  await ensureColumn('general_expenses', 'responsible', 'VARCHAR(255) NULL');

  // категории и подкатегории расходов — редактируемый пользователем справочник (не жёстко
  // зашитый список), чтобы можно было добавлять свои категории прямо из формы расхода
  // простые настройки приложения (ключ-значение) — сейчас нужны для курса USD→смн,
  // чтобы правильно конвертировать расход из Meta Ads (там кабинет считает в USD, а
  // не в сомони — курс нужно иногда обновлять вручную, поэтому не жёстко зашит в код)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      \`key\`   VARCHAR(100) PRIMARY KEY,
      value    VARCHAR(255) NOT NULL
    )
  `);
  const [[rateRow]] = await pool.query("SELECT value FROM app_settings WHERE \`key\` = 'usd_to_tjs_rate'");
  if (!rateRow) {
    await pool.query("INSERT INTO app_settings (\`key\`, value) VALUES ('usd_to_tjs_rate', '9.27')");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      parent_id  INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES expense_categories(id) ON DELETE CASCADE
    )
  `);
  const [[catCountRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM expense_categories');
  if (Number(catCountRow.cnt) === 0) {
    // заполняем стандартный набор категорий один раз, при первом запуске на пустой таблице
    const defaultCats = {
      'Реклама': ['Instagram Ads', 'Facebook Ads', 'TikTok Ads', 'Блогеры', 'Другие рекламные расходы'],
      'Логистика': ['Доставка', 'Транспорт', 'Склад', 'Другие логистические расходы'],
      'Курьеры': [],
      'Зарплаты': ['SMM', 'Менеджеры', 'Оператор', 'Дизайнер', 'Другие сотрудники'],
      'Упаковка': [],
      'Аренда': [],
      'Комиссии': [],
      'Возвраты': [],
      'Прочее': [],
    };
    for (const [name, subs] of Object.entries(defaultCats)) {
      const [r] = await pool.query('INSERT INTO expense_categories (name, parent_id) VALUES (?, NULL)', [name]);
      for (const sub of subs) {
        await pool.query('INSERT INTO expense_categories (name, parent_id) VALUES (?, ?)', [sub, r.insertId]);
      }
    }
    console.log('Заполнены стандартные категории расходов');
  }

  // возвраты — отдельный журнал (для истории), плюс сумма возврата хранится прямо на заказе
  // (orders.refunded_amount), чтобы выручку/себестоимость/комиссию партнёра было просто
  // пересчитать везде одной формулой: "total - refunded_amount" вместо "total"
  await ensureColumn('orders', 'refunded_amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refunds (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      order_id   INT NOT NULL,
      amount     DECIMAL(10,2) NOT NULL,
      reason     VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owner_transactions (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      type              ENUM('contribution','withdrawal') NOT NULL,
      amount            DECIMAL(10,2) NOT NULL,
      transaction_date  DATE NOT NULL,
      note              VARCHAR(255),
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensurePartnerTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partners (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      name                VARCHAR(255) NOT NULL,
      phone               VARCHAR(50),
      telegram            VARCHAR(255),
      deal_type           ENUM('commission','wholesale') NOT NULL DEFAULT 'commission',
      commission_percent  DECIMAL(5,2) NOT NULL DEFAULT 0,
      notes               TEXT,
      active              TINYINT(1) NOT NULL DEFAULT 1,
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn('partners', 'commission_basis', "ENUM('gross','net') NOT NULL DEFAULT 'gross'");
  // commission_basis: 'gross' — комиссия считается от валовой прибыли (цена - себестоимость) по товарам партнёра,
  //                    'net'   — комиссия считается от чистой прибыли: после вычета доли операционных расходов
  //                              (курьеры, реклама, общие расходы), пропорциональной выручке этого партнёра
  await ensureColumn('partners', 'wholesale_credit_days', 'INT NULL');
  await ensureColumn('partners', 'wholesale_penalty_percent_per_day', 'DECIMAL(6,3) NOT NULL DEFAULT 0');
  // для оптовых партнёров с отсрочкой платежа (wholesale_payment_timing='on_sale'):
  // wholesale_credit_days — сколько дней после поступления товара (products.received_at) есть на оплату,
  // wholesale_penalty_percent_per_day — штраф в % в день от неоплаченного просроченного долга, если не успели
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_expenses (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      partner_id            INT NOT NULL,
      title                 VARCHAR(255) NOT NULL,
      amount                DECIMAL(10,2) NOT NULL,
      partner_share_percent DECIMAL(5,2) NOT NULL DEFAULT 100,
      created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pe_partner (partner_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_payouts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      partner_id  INT NOT NULL,
      amount      DECIMAL(10,2) NOT NULL,
      note        VARCHAR(255),
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pp_partner (partner_id)
    )
  `);
  await ensureColumn('products', 'partner_id', 'INT NULL');
  await ensureColumn('partners', 'wholesale_payment_timing', "ENUM('immediate','on_sale') NOT NULL DEFAULT 'on_sale'");
}

async function ensureCourierTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS couriers (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      telegram_chat_id  BIGINT NULL UNIQUE,
      first_name        VARCHAR(255),
      last_name         VARCHAR(255),
      username          VARCHAR(255),
      display_name      VARCHAR(255),
      phone             VARCHAR(50),
      phone2            VARCHAR(50),
      vehicle_type      VARCHAR(50),
      vehicle_number    VARCHAR(50),
      inn               VARCHAR(50),
      passport_number   VARCHAR(50),
      address           VARCHAR(255),
      active            TINYINT(1) NOT NULL DEFAULT 1,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // на случай, если таблица уже существовала в старом виде — доводим до нужной структуры
  await ensureColumn('couriers', 'last_name', 'VARCHAR(255) NULL');
  await ensureColumn('couriers', 'phone', 'VARCHAR(50) NULL');
  await ensureColumn('couriers', 'phone2', 'VARCHAR(50) NULL');
  await ensureColumn('couriers', 'vehicle_type', 'VARCHAR(50) NULL');
  await ensureColumn('couriers', 'vehicle_number', 'VARCHAR(50) NULL');
  await ensureColumn('couriers', 'inn', 'VARCHAR(50) NULL');
  await ensureColumn('couriers', 'passport_number', 'VARCHAR(50) NULL');
  await ensureColumn('couriers', 'address', 'VARCHAR(255) NULL');
  await ensureColumn('couriers', 'salary_type', "ENUM('fixed','per_delivery') NOT NULL DEFAULT 'per_delivery'");
  await ensureColumn('couriers', 'salary_rate', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
  try { await pool.query('ALTER TABLE couriers MODIFY COLUMN telegram_chat_id BIGINT NULL'); } catch (e) { /* уже так */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS courier_payouts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      courier_id  INT NOT NULL,
      amount      DECIMAL(10,2) NOT NULL,
      note        VARCHAR(255),
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cp_courier (courier_id)
    )
  `);

  await ensureColumn('orders', 'courier_id', 'INT NULL');
  await ensureColumn('orders', 'delivery_status', "ENUM('waiting','accepted','in_transit','delivered') NOT NULL DEFAULT 'waiting'");
  await ensureColumn('orders', 'telegram_broadcast', 'JSON NULL');
  await ensureColumn('orders', 'completed_at', 'DATETIME NULL');
  // completed_at — дата, когда заказ реально стал "Выполнен" (курьер доставил / админ закрыл вручную).
  // Именно по этой дате, а не по дате СОЗДАНИЯ заказа (created_at), должна считаться выручка в
  // Финансах — иначе заказ, оформленный вчера и доставленный сегодня, "проваливался" бы в отчёт
  // за вчера и пропадал из сегодняшней выручки.
  const [backfillResult] = await pool.query(
    "UPDATE orders SET completed_at = created_at WHERE status = 'done' AND completed_at IS NULL"
  );
  if (backfillResult.affectedRows > 0) {
    console.log(`Заполнена дата завершения (completed_at) для ${backfillResult.affectedRows} старых заказов`);
  }
}

async function ensureModelMediaTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_model_media (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      product_id  INT NOT NULL,
      color       VARCHAR(100),
      body_type   ENUM('slim','plus') NOT NULL DEFAULT 'slim',
      media_type  ENUM('video','image') NOT NULL DEFAULT 'video',
      media_data  LONGTEXT NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pmm_product (product_id)
    )
  `);
}

async function ensureProductColumns() {
  await ensureColumn('products', 'image_data', 'MEDIUMTEXT NULL');
  await ensureColumn('products', 'subtitle_ru', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'subtitle_tj', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'bundle2_price', 'DECIMAL(10,2) NULL');
  await ensureColumn('products', 'bundle3_price', 'DECIMAL(10,2) NULL');
  await ensureColumn('products', 'bundle4_price', 'DECIMAL(10,2) NULL');
  await ensureColumn('products', 'features_ru', 'TEXT NULL');
  await ensureColumn('products', 'features_tj', 'TEXT NULL');
  await ensureColumn('products', 'delivery_ru', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'delivery_tj', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'warranty_ru', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'warranty_tj', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'cost_price', 'DECIMAL(10,2) NULL');
  await ensureColumn('products', 'stock', 'INT NULL');
  await ensureColumn('products', 'rating', 'DECIMAL(2,1) NULL DEFAULT 4.8');
  await ensureColumn('products', 'rating_count', 'INT NULL DEFAULT 0');
  await ensureColumn('products', 'colors', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'sizes', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'views', 'INT NOT NULL DEFAULT 0');
  await ensureColumn('products', 'extra_images', 'JSON NULL');
  await ensureColumn('products', 'seller_name', 'VARCHAR(255) NULL');
  await ensureColumn('products', 'active', 'TINYINT(1) NOT NULL DEFAULT 1');
  await ensureColumn('products', 'received_at', 'DATE NULL');
  // received_at — дата, когда партнёр привёз эту партию товара; точка отсчёта срока оплаты
  // для оптовых партнёров "в кредит". Если не заполнено вручную — считаем от даты создания товара.
}

// ----------------------------------------------------------------------------
// создаём таблицы при старте, если их ещё нет — не нужно вручную
// выполнять schema.sql через сторонние программы
// ----------------------------------------------------------------------------
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      customer_name     VARCHAR(255) NOT NULL,
      customer_phone    VARCHAR(50)  NOT NULL,
      customer_address  VARCHAR(255),
      comment           TEXT,
      items             JSON NOT NULL,
      total             DECIMAL(10,2) NOT NULL DEFAULT 0,
      status            ENUM('new','progress','done','cancel') NOT NULL DEFAULT 'new',
      channel           VARCHAR(20),
      INDEX idx_orders_created_at (created_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      cat         VARCHAR(50) NOT NULL,
      name_ru     VARCHAR(255) NOT NULL,
      name_tj     VARCHAR(255) NOT NULL,
      price       DECIMAL(10,2) NOT NULL,
      old_price   DECIMAL(10,2),
      emoji       VARCHAR(10) NOT NULL DEFAULT '🛍️',
      tag         VARCHAR(20),
      desc_ru     TEXT,
      desc_tj     TEXT,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureProductColumns();
  await ensureModelMediaTable();
  await ensureCourierTables();
  await ensurePartnerTables();
  await ensurePurchasesTable();
  await ensureFinanceTables();
  await ensureMarketingTables();
  await ensureVisitsTable();
  await ensureHrTables();

  // если товаров ещё нет — заполняем стартовым набором, чтобы сайт не был пустым
  const [[{ count }]] = await pool.query('SELECT COUNT(*) as count FROM products');
  if (count === 0) {
    const seed = [
      ['electronics','Беспроводные наушники','Гӯшмонакҳои бесим',249,null,'🎧','top','Качественные наушники с чётким звуком, автономность до 20 часов.','Гӯшмонакҳои сифатнок бо садои возеҳ, батарея то 20 соат кор мекунад.'],
      ['electronics','Умные часы','Соати ҳушманд',890,null,'⌚','top','Мониторинг здоровья, уведомления и быстрая зарядка в одном устройстве.','Назорати саломатӣ, огоҳиномаҳо ва зарядкунии тезкор дар як дастгоҳ.'],
      ['electronics','Беспроводная зарядка','Зарядкунаки бесим',120,null,'🔌','new','Беспроводная зарядка для современных смартфонов — просто и быстро.','Зарядкунии бидуни сим барои телефонҳои муосир — сода ва тезкор.'],
      ['electronics','Bluetooth-колонка','Баландгӯяки Bluetooth',320,null,'🔊',null,'Громкий и чистый звук для дома и улицы, простое подключение.','Садои баланд ва аниқ барои хона ва берун, пайвасти осон.'],
      ['electronics','Повербанк 20000mAh','Пауэрбанк 20000mAh',280,null,'🔋','new','Большой запас энергии — хватит зарядить телефон несколько раз в дороге.','Захираи калон — якчанд маротиба заряд кардани телефон дар сафар.'],
      ['clothing','Мужская куртка','Куртаи мардона',450,null,'🧥','top','Тёплая и прочная ткань для холодного сезона, разные размеры.','Матои гарм ва мустаҳкам барои мавсими хунук, андозаҳои гуногун.'],
      ['clothing','Женские джинсы','Ҷинси занона',260,null,'👖',null,'Качественная ткань современного кроя, подходит на каждый день.','Матои сифатнок бо буриши муосир, барои ҳар рӯз мувофиқ.'],
      ['clothing','Хлопковая футболка','Куртаи пахтагӣ',90,null,'👕','new','100% хлопок, приятен к телу и хорошо пропускает воздух.','Пахтаи 100% нафис, нарм ба пӯст ва хунукиро хуб мегузаронад.'],
      ['clothing','Спортивный костюм','Костюми варзишӣ',380,null,'🏃',null,'Мягкая ткань для спорта и отдыха, не сковывает движения.','Матои нафис барои машқ ва истироҳат, ҳаракатро маҳдуд намекунад.'],
      ['bags','Школьный рюкзак','Ҷузвдони мактабӣ',210,null,'🎒','top','Вместительный рюкзак для книг и ноутбука, мягкие лямки.','Ҷойи васеъ барои китобҳо ва ноутбук, пуштибанди мулоим.'],
      ['bags','Женская сумка','Сумкаи занона',340,null,'👜','new','Женский дизайн с несколькими отделениями — для работы и прогулок.','Тарҳи занона бо якчанд ҷайб, барои кор ва берун рафтан.'],
      ['bags','Кошелёк','Ҳамён',95,null,'👛',null,'Отделения для карт и денег, качественная кожа.','Ҷойҳо барои корт ва пул, чарми сифатнок.'],
      ['bags','Дорожная сумка','Ҷузвдони сафарӣ',460,null,'🧳',null,'Большой объём для дальних поездок, прочный и надёжный.','Ҳаҷми калон барои сафарҳои дароз, мустаҳкам ва бодавом.'],
    ];
    for (let i = 0; i < seed.length; i++) {
      const [cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj] = seed[i];
      await pool.query(
        `INSERT INTO products (cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj, i]
      );
    }
    console.log('Таблица products была пустой — добавлен стартовый набор из', seed.length, 'товаров.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS banners (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      image_data  MEDIUMTEXT NOT NULL,
      link_url    VARCHAR(500),
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // одноразовое исправление: заказы, которые уже отмечены "Выполнен" и имеют курьера,
  // но из-за старого бага остались с delivery_status != 'delivered' — досчитываем их
  // задним числом, чтобы зарплата курьеров и расходы в Финансах сразу стали верными
  const [fixResult] = await pool.query(
    "UPDATE orders SET delivery_status = 'delivered' WHERE status = 'done' AND courier_id IS NOT NULL AND delivery_status <> 'delivered'"
  );
  if (fixResult.affectedRows > 0) {
    console.log(`Исправлено заказов с несинхронизированным delivery_status: ${fixResult.affectedRows}`);
  }

  console.log('Таблицы orders, products и banners готовы.');
}

// ----------------------------------------------------------------------------
// БАННЕРЫ — публичный список (для сайта) + управление только для администратора
// ----------------------------------------------------------------------------
app.get('/api/banners', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM banners ORDER BY sort_order ASC, id ASC');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка получения баннеров:', e);
    res.status(500).json({ error: 'Не удалось получить баннеры' });
  }
});

app.post('/api/banners', requireAuth, async (req, res) => {
  const { image_data, link_url } = req.body || {};
  if (!image_data) {
    return res.status(400).json({ error: 'Нужно фото баннера' });
  }
  try {
    const [[{ maxOrder }]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) as maxOrder FROM banners');
    const [result] = await pool.query(
      'INSERT INTO banners (image_data, link_url, sort_order) VALUES (?, ?, ?)',
      [image_data, link_url || null, maxOrder + 1]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка создания баннера:', e);
    res.status(500).json({ error: 'Не удалось создать баннер' });
  }
});

app.delete('/api/banners/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM banners WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления баннера:', e);
    res.status(500).json({ error: 'Не удалось удалить баннер' });
  }
});

app.patch('/api/banners/:id/move', requireAuth, async (req, res) => {
  const { direction } = req.body || {};
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction должен быть up или down' });
  }
  try {
    const [[current]] = await pool.query('SELECT * FROM banners WHERE id = ?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Баннер не найден' });

    const [[neighbor]] = await pool.query(
      direction === 'up'
        ? 'SELECT * FROM banners WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1'
        : 'SELECT * FROM banners WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1',
      [current.sort_order]
    );
    if (!neighbor) return res.json({ ok: true }); // уже крайний, менять нечего

    await pool.query('UPDATE banners SET sort_order = ? WHERE id = ?', [neighbor.sort_order, current.id]);
    await pool.query('UPDATE banners SET sort_order = ? WHERE id = ?', [current.sort_order, neighbor.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка перемещения баннера:', e);
    res.status(500).json({ error: 'Не удалось переместить баннер' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ----------------------------------------------------------------------------
// отдельные "страницы" товара (/product/название-id) — отдаём тот же сайт,
// а нужный товар открывает уже JS на странице по числу в конце ссылки
// ----------------------------------------------------------------------------
app.get('/product/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ----------------------------------------------------------------------------
// раздаём статические файлы сайта (index.html, admin.html) с того же сервера
// ----------------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

ensureSchema()
  .catch(e => console.error('Не удалось создать таблицу orders при старте:', e))
  .finally(() => {
    app.listen(PORT, () => console.log(`Сервер ХАМАБОЗОР запущен на порту ${PORT}`));
    scheduleDailyDigest();
  });
