require('dotenv').config();
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

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
app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_phone, customer_address, comment, items, total, channel } = req.body || {};

  if (!customer_name || !customer_phone || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Не хватает обязательных полей заказа' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, customer_address, comment, items, total, status, channel)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
      [customer_name, customer_phone, customer_address || null, comment || null, JSON.stringify(items), total || 0, channel || null]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка создания заказа:', e);
    res.status(500).json({ error: 'Не удалось сохранить заказ' });
  }
});

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
    const [rows] = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
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
    await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка обновления статуса:', e);
    res.status(500).json({ error: 'Не удалось обновить статус' });
  }
});

// ----------------------------------------------------------------------------
// ТОВАРЫ — публичный список (для сайта) + CRUD только для администратора
// ----------------------------------------------------------------------------
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products ORDER BY sort_order ASC, id ASC');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка получения товаров:', e);
    res.status(500).json({ error: 'Не удалось получить товары' });
  }
});

app.post('/api/products', requireAuth, async (req, res) => {
  const { cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj } = req.body || {};
  if (!cat || !name_ru || !name_tj || price == null) {
    return res.status(400).json({ error: 'Не хватает обязательных полей товара' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO products (cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cat, name_ru, name_tj, price, old_price || null, emoji || '🛍️', tag || null, desc_ru || '', desc_tj || '']
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('Ошибка создания товара:', e);
    res.status(500).json({ error: 'Не удалось создать товар' });
  }
});

app.put('/api/products/:id', requireAuth, async (req, res) => {
  const { cat, name_ru, name_tj, price, old_price, emoji, tag, desc_ru, desc_tj } = req.body || {};
  if (!cat || !name_ru || !name_tj || price == null) {
    return res.status(400).json({ error: 'Не хватает обязательных полей товара' });
  }
  try {
    await pool.query(
      `UPDATE products SET cat=?, name_ru=?, name_tj=?, price=?, old_price=?, emoji=?, tag=?, desc_ru=?, desc_tj=?
       WHERE id=?`,
      [cat, name_ru, name_tj, price, old_price || null, emoji || '🛍️', tag || null, desc_ru || '', desc_tj || '', req.params.id]
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

  console.log('Таблицы orders и products готовы.');
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ----------------------------------------------------------------------------
// раздаём статические файлы сайта (index.html, admin.html) с того же сервера
// ----------------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

ensureSchema()
  .catch(e => console.error('Не удалось создать таблицу orders при старте:', e))
  .finally(() => {
    app.listen(PORT, () => console.log(`Сервер ХАМАБОЗОР запущен на порту ${PORT}`));
  });
