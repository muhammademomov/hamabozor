// ----------------------------------------------------------------------------
// КАРГО: личный кабинет клиента (код + адрес склада в Китае + трек-коды посылок)
// и управление посылками в админке.
// Клиентские токены подписываются ОТДЕЛЬНЫМ секретом, поэтому клиентский токен
// никогда не пройдёт проверку requireAuth (админскую).
// ----------------------------------------------------------------------------

// ожидание → принят на складе → в пути → сортировка → готов к выдаче → курьер → получен (+ потерян)
const STATUSES = ['expected', 'warehouse', 'transit', 'sorting', 'ready', 'courier', 'delivered', 'lost'];

const DEFAULT_ADDRESS =
  'Адрес склада в Китае пока не указан — администратор добавит его в разделе «Карго».\nВаш код: {code}';

module.exports = function registerCargo({ app, pool, requireAuth, jwt, bcrypt, JWT_SECRET }) {
  const CUSTOMER_SECRET = (JWT_SECRET || 'dev') + ':cargo-customer';

  // --- простая защита от перебора пароля: 10 попыток за 15 минут с одного IP ---
  const attempts = new Map();
  function tooManyAttempts(req) {
    const ip = req.ip || 'x';
    const now = Date.now();
    const rec = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
    attempts.set(ip, rec);
    return rec.length >= 10;
  }
  function noteAttempt(req) {
    const ip = req.ip || 'x';
    const rec = attempts.get(ip) || [];
    rec.push(Date.now());
    attempts.set(ip, rec);
  }

  const normPhone = s => String(s || '').replace(/\D/g, '');
  const normTrack = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
  const cargoCodeFor = id => 'HB' + (1000 + Number(id));

  function requireCustomer(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Войдите в личный кабинет' });
    try {
      const data = jwt.verify(token, CUSTOMER_SECRET);
      req.customerId = data.cid;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Сессия истекла, войдите заново' });
    }
  }

  async function getSetting(key, fallback) {
    const [[row]] = await pool.query('SELECT value FROM cargo_settings WHERE `key` = ?', [key]);
    return row ? row.value : fallback;
  }
  async function setSetting(key, value) {
    await pool.query(
      'INSERT INTO cargo_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
      [key, value, value]
    );
  }

  async function ensureCargoTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cargo_customers (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        name           VARCHAR(255) NOT NULL,
        phone          VARCHAR(30)  NOT NULL,
        password_hash  VARCHAR(100) NOT NULL,
        cargo_code     VARCHAR(20),
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cargo_phone (phone),
        UNIQUE KEY uq_cargo_code (cargo_code)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cargo_parcels (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        customer_id  INT NULL,
        track_code   VARCHAR(60) NOT NULL,
        description  VARCHAR(255),
        status       VARCHAR(20) NOT NULL DEFAULT 'expected',
        weight_kg    DECIMAL(10,3) NULL,
        price        DECIMAL(10,2) NULL,
        paid         TINYINT(1) NOT NULL DEFAULT 0,
        created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cargo_track (track_code),
        INDEX idx_cargo_parcels_customer (customer_id),
        INDEX idx_cargo_parcels_status (status)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cargo_parcel_events (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        parcel_id   INT NOT NULL,
        status      VARCHAR(20) NOT NULL,
        note        VARCHAR(255),
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cargo_events_parcel (parcel_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cargo_settings (
        \`key\` VARCHAR(50) PRIMARY KEY,
        value   TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cargo_pickup_points (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(120) NOT NULL,
        address     VARCHAR(255),
        sort_order  INT NOT NULL DEFAULT 0,
        active      TINYINT(1) NOT NULL DEFAULT 1
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cargo_wallet_tx (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        customer_id  INT NOT NULL,
        amount       DECIMAL(12,2) NOT NULL,
        kind         VARCHAR(20) NOT NULL,
        note         VARCHAR(255),
        parcel_id    INT NULL,
        created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cargo_tx_customer (customer_id)
      )
    `);
    await ensureColumn('cargo_customers', 'pickup_point_id', 'INT NULL');
    await ensureColumn('cargo_customers', 'balance', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
    await ensureColumn('cargo_parcels', 'delivery_address', 'VARCHAR(500) NULL');
    await ensureColumn('cargo_parcels', 'delivery_requested', 'TINYINT(1) NOT NULL DEFAULT 0');
    // старый статус «Прибыла в Душанбе» теперь называется «В сортировочном центре»
    await pool.query("UPDATE cargo_parcels SET status = 'sorting' WHERE status = 'arrived'");
    await pool.query("UPDATE cargo_parcel_events SET status = 'sorting' WHERE status = 'arrived'");
    console.log('Таблицы карго готовы.');
  }

  async function ensureColumn(table, column, definition) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
      [table, column]
    );
    if (rows[0].cnt === 0) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async function addEvent(parcelId, status, note) {
    await pool.query('INSERT INTO cargo_parcel_events (parcel_id, status, note) VALUES (?, ?, ?)', [
      parcelId,
      status,
      note || null,
    ]);
  }

  // --------------------------------------------------------------------------
  // КЛИЕНТ
  // --------------------------------------------------------------------------
  app.get('/api/cargo/info', async (req, res) => {
    try {
      res.json({
        price_per_kg: Number(await getSetting('price_per_kg', 0)) || 0,
        contact_phone: await getSetting('contact_phone', ''),
      });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить данные' });
    }
  });

  app.post('/api/cargo/register', async (req, res) => {
    if (tooManyAttempts(req)) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    const name = String((req.body || {}).name || '').trim();
    const phone = normPhone((req.body || {}).phone);
    const password = String((req.body || {}).password || '');
    if (!name) return res.status(400).json({ error: 'Укажите имя' });
    if (phone.length < 9 || phone.length > 15) return res.status(400).json({ error: 'Укажите телефон' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль — минимум 6 символов' });
    noteAttempt(req);
    try {
      const [[exists]] = await pool.query('SELECT id FROM cargo_customers WHERE phone = ?', [phone]);
      if (exists) return res.status(409).json({ error: 'Этот телефон уже зарегистрирован — войдите' });
      const hash = await bcrypt.hash(password, 10);
      const [r] = await pool.query(
        'INSERT INTO cargo_customers (name, phone, password_hash) VALUES (?, ?, ?)',
        [name.slice(0, 255), phone, hash]
      );
      await pool.query('UPDATE cargo_customers SET cargo_code = ? WHERE id = ?', [cargoCodeFor(r.insertId), r.insertId]);
      const token = jwt.sign({ cid: r.insertId }, CUSTOMER_SECRET, { expiresIn: '60d' });
      res.json({ token });
    } catch (e) {
      console.error('Ошибка регистрации карго:', e);
      res.status(500).json({ error: 'Не удалось зарегистрироваться' });
    }
  });

  app.post('/api/cargo/login', async (req, res) => {
    if (tooManyAttempts(req)) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    const phone = normPhone((req.body || {}).phone);
    const password = String((req.body || {}).password || '');
    noteAttempt(req);
    try {
      const [[c]] = await pool.query('SELECT id, password_hash FROM cargo_customers WHERE phone = ?', [phone]);
      const ok = c && (await bcrypt.compare(password, c.password_hash));
      if (!ok) return res.status(401).json({ error: 'Неверный телефон или пароль' });
      const token = jwt.sign({ cid: c.id }, CUSTOMER_SECRET, { expiresIn: '60d' });
      res.json({ token });
    } catch (e) {
      console.error('Ошибка входа карго:', e);
      res.status(500).json({ error: 'Не удалось войти' });
    }
  });

  app.get('/api/cargo/me', requireCustomer, async (req, res) => {
    try {
      const [[c]] = await pool.query(
        'SELECT id, name, phone, cargo_code, balance, pickup_point_id FROM cargo_customers WHERE id = ?',
        [req.customerId]
      );
      if (!c) return res.status(401).json({ error: 'Аккаунт не найден' });
      const [parcels] = await pool.query(
        'SELECT id, track_code, description, status, weight_kg, price, paid, delivery_address, delivery_requested, created_at, updated_at FROM cargo_parcels WHERE customer_id = ? ORDER BY updated_at DESC, id DESC',
        [c.id]
      );
      let events = [];
      if (parcels.length) {
        [events] = await pool.query(
          `SELECT parcel_id, status, note, created_at FROM cargo_parcel_events WHERE parcel_id IN (${parcels.map(() => '?').join(',')}) ORDER BY id ASC`,
          parcels.map(p => p.id)
        );
      }
      const byParcel = {};
      events.forEach(e => { (byParcel[e.parcel_id] = byParcel[e.parcel_id] || []).push(e); });
      const [tx] = await pool.query(
        'SELECT id, amount, kind, note, parcel_id, created_at FROM cargo_wallet_tx WHERE customer_id = ? ORDER BY id DESC LIMIT 100',
        [c.id]
      );
      const [points] = await pool.query(
        'SELECT id, name, address FROM cargo_pickup_points WHERE active = 1 ORDER BY sort_order, id'
      );
      const template = await getSetting('address', DEFAULT_ADDRESS);
      res.json({
        customer: { name: c.name, phone: c.phone, code: c.cargo_code, pickup_point_id: c.pickup_point_id },
        balance: Number(c.balance) || 0,
        warehouse: {
          recipient: c.cargo_code,
          phone: await getSetting('warehouse_phone', ''),
          address: template.split('{code}').join(c.cargo_code),
        },
        price_per_kg: Number(await getSetting('price_per_kg', 0)) || 0,
        contact_phone: await getSetting('contact_phone', ''),
        payment_info: await getSetting('payment_info', ''),
        pickup_points: points,
        transactions: tx,
        parcels: parcels.map(p => ({ ...p, events: byParcel[p.id] || [] })),
      });
    } catch (e) {
      console.error('Ошибка кабинета карго:', e);
      res.status(500).json({ error: 'Не удалось загрузить кабинет' });
    }
  });

  // сменить пароль (клиент знает старый)
  app.post('/api/cargo/password', requireCustomer, async (req, res) => {
    const oldPass = String((req.body || {}).old_password || '');
    const newPass = String((req.body || {}).new_password || '');
    if (newPass.length < 6) return res.status(400).json({ error: 'Новый пароль — минимум 6 символов' });
    if (tooManyAttempts(req)) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    noteAttempt(req);
    try {
      const [[c]] = await pool.query('SELECT id, password_hash FROM cargo_customers WHERE id = ?', [req.customerId]);
      if (!c || !(await bcrypt.compare(oldPass, c.password_hash))) return res.status(400).json({ error: 'Старый пароль неверный' });
      await pool.query('UPDATE cargo_customers SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPass, 10), c.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось сменить пароль' });
    }
  });

  // выбрать пункт выдачи (ПВЗ)
  app.post('/api/cargo/pickup', requireCustomer, async (req, res) => {
    const id = Number((req.body || {}).pickup_point_id);
    try {
      if (id) {
        const [[pt]] = await pool.query('SELECT id FROM cargo_pickup_points WHERE id = ? AND active = 1', [id]);
        if (!pt) return res.status(404).json({ error: 'Пункт выдачи не найден' });
      }
      await pool.query('UPDATE cargo_customers SET pickup_point_id = ? WHERE id = ?', [id || null, req.customerId]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось сохранить' });
    }
  });

  // заказать доставку курьером до дома для всех посылок, которые уже готовы к выдаче
  app.post('/api/cargo/delivery', requireCustomer, async (req, res) => {
    const address = String((req.body || {}).address || '').trim().slice(0, 500);
    if (address.length < 5) return res.status(400).json({ error: 'Укажите адрес доставки' });
    try {
      const [r] = await pool.query(
        "UPDATE cargo_parcels SET delivery_requested = 1, delivery_address = ? WHERE customer_id = ? AND status IN ('sorting', 'ready')",
        [address, req.customerId]
      );
      if (!r.affectedRows) return res.status(400).json({ error: 'Пока нет посылок, готовых к выдаче' });
      res.json({ ok: true, parcels: r.affectedRows });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось оформить доставку' });
    }
  });

  // оплатить посылку с баланса кошелька
  app.post('/api/cargo/parcels/:id/pay', requireCustomer, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[c]] = await conn.query('SELECT id, balance FROM cargo_customers WHERE id = ? FOR UPDATE', [req.customerId]);
      const [[p]] = await conn.query('SELECT id, track_code, price, paid FROM cargo_parcels WHERE id = ? AND customer_id = ? FOR UPDATE', [req.params.id, req.customerId]);
      if (!c || !p) { await conn.rollback(); return res.status(404).json({ error: 'Посылка не найдена' }); }
      if (p.paid) { await conn.rollback(); return res.status(400).json({ error: 'Посылка уже оплачена' }); }
      if (p.price == null) { await conn.rollback(); return res.status(400).json({ error: 'Стоимость ещё не рассчитана' }); }
      const price = Number(p.price);
      if (Number(c.balance) < price) { await conn.rollback(); return res.status(400).json({ error: 'Недостаточно средств — пополните кошелёк' }); }
      await conn.query('UPDATE cargo_customers SET balance = balance - ? WHERE id = ?', [price, c.id]);
      await conn.query('UPDATE cargo_parcels SET paid = 1 WHERE id = ?', [p.id]);
      await conn.query(
        'INSERT INTO cargo_wallet_tx (customer_id, amount, kind, note, parcel_id) VALUES (?, ?, ?, ?, ?)',
        [c.id, -price, 'payment', 'Оплата посылки ' + p.track_code, p.id]
      );
      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      console.error('Ошибка оплаты посылки:', e);
      res.status(500).json({ error: 'Не удалось оплатить' });
    } finally {
      conn.release();
    }
  });

  app.post('/api/cargo/parcels', requireCustomer, async (req, res) => {
    const track = normTrack((req.body || {}).track_code);
    const description = String((req.body || {}).description || '').trim().slice(0, 255);
    if (!/^[A-Z0-9\-_.]{5,60}$/.test(track)) {
      return res.status(400).json({ error: 'Трек-код: 5–60 символов, только буквы и цифры' });
    }
    try {
      const [[existing]] = await pool.query('SELECT id, customer_id FROM cargo_parcels WHERE track_code = ?', [track]);
      if (existing) {
        if (existing.customer_id === req.customerId) return res.status(409).json({ error: 'Этот трек-код уже добавлен' });
        if (existing.customer_id) return res.status(409).json({ error: 'Этот трек-код уже занят другим клиентом' });
        // посылка уже пришла на склад без владельца — закрепляем за клиентом
        await pool.query('UPDATE cargo_parcels SET customer_id = ?, description = COALESCE(NULLIF(?, \'\'), description) WHERE id = ?', [req.customerId, description, existing.id]);
        return res.json({ id: existing.id, claimed: true });
      }
      const [r] = await pool.query(
        'INSERT INTO cargo_parcels (customer_id, track_code, description) VALUES (?, ?, ?)',
        [req.customerId, track, description || null]
      );
      await addEvent(r.insertId, 'expected', 'Трек-код добавлен клиентом');
      res.json({ id: r.insertId });
    } catch (e) {
      console.error('Ошибка добавления трек-кода:', e);
      res.status(500).json({ error: 'Не удалось добавить трек-код' });
    }
  });

  app.delete('/api/cargo/parcels/:id', requireCustomer, async (req, res) => {
    try {
      const [[p]] = await pool.query('SELECT id, status FROM cargo_parcels WHERE id = ? AND customer_id = ?', [req.params.id, req.customerId]);
      if (!p) return res.status(404).json({ error: 'Посылка не найдена' });
      if (p.status !== 'expected') return res.status(400).json({ error: 'Посылку уже приняли на складе — удалить нельзя' });
      await pool.query('DELETE FROM cargo_parcels WHERE id = ?', [p.id]);
      await pool.query('DELETE FROM cargo_parcel_events WHERE parcel_id = ?', [p.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось удалить' });
    }
  });

  // --------------------------------------------------------------------------
  // АДМИНКА
  // --------------------------------------------------------------------------
  app.get('/api/admin/cargo/settings', requireAuth, async (req, res) => {
    try {
      res.json({
        address: await getSetting('address', ''),
        price_per_kg: await getSetting('price_per_kg', ''),
        contact_phone: await getSetting('contact_phone', ''),
        warehouse_phone: await getSetting('warehouse_phone', ''),
        payment_info: await getSetting('payment_info', ''),
      });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить настройки' });
    }
  });

  app.put('/api/admin/cargo/settings', requireAuth, async (req, res) => {
    const b = req.body || {};
    try {
      if (b.address != null) await setSetting('address', String(b.address).slice(0, 2000));
      if (b.price_per_kg != null) {
        const n = Number(b.price_per_kg);
        if (b.price_per_kg !== '' && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ error: 'Неверная цена за кг' });
        await setSetting('price_per_kg', b.price_per_kg === '' ? '0' : String(n));
      }
      if (b.contact_phone != null) await setSetting('contact_phone', String(b.contact_phone).slice(0, 50));
      if (b.warehouse_phone != null) await setSetting('warehouse_phone', String(b.warehouse_phone).slice(0, 50));
      if (b.payment_info != null) await setSetting('payment_info', String(b.payment_info).slice(0, 2000));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось сохранить настройки' });
    }
  });

  app.get('/api/admin/cargo/parcels', requireAuth, async (req, res) => {
    const { status, q, owner, delivery, unpaid, customer_id } = req.query;
    const where = [];
    const params = [];
    if (status && STATUSES.includes(status)) { where.push('p.status = ?'); params.push(status); }
    if (status === 'active') where.push("p.status NOT IN ('delivered','lost')");
    if (owner === 'none') where.push('p.customer_id IS NULL');
    if (delivery === '1') where.push("p.delivery_requested = 1 AND p.status NOT IN ('delivered','lost')");
    if (unpaid === '1') where.push('p.price IS NOT NULL AND p.paid = 0');
    if (customer_id) { where.push('p.customer_id = ?'); params.push(Number(customer_id)); }
    if (q) {
      const like = '%' + String(q).trim() + '%';
      where.push('(p.track_code LIKE ? OR c.cargo_code LIKE ? OR c.phone LIKE ? OR c.name LIKE ?)');
      params.push(like, like, like, like);
    }
    try {
      const [rows] = await pool.query(
        `SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, c.cargo_code, pp.name AS pickup_name
           FROM cargo_parcels p LEFT JOIN cargo_customers c ON c.id = p.customer_id
           LEFT JOIN cargo_pickup_points pp ON pp.id = c.pickup_point_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY p.updated_at DESC, p.id DESC LIMIT 500`,
        params
      );
      res.json(rows);
    } catch (e) {
      console.error('Ошибка списка посылок:', e);
      res.status(500).json({ error: 'Не удалось получить посылки' });
    }
  });

  // принять посылку на складе: можно указать код клиента, а можно оставить без владельца
  app.post('/api/admin/cargo/parcels', requireAuth, async (req, res) => {
    const b = req.body || {};
    const track = normTrack(b.track_code);
    if (!/^[A-Z0-9\-_.]{5,60}$/.test(track)) return res.status(400).json({ error: 'Неверный трек-код' });
    const status = STATUSES.includes(b.status) ? b.status : 'warehouse';
    try {
      let customerId = null;
      if (b.cargo_code) {
        const [[c]] = await pool.query('SELECT id FROM cargo_customers WHERE cargo_code = ?', [String(b.cargo_code).trim().toUpperCase()]);
        if (!c) return res.status(404).json({ error: 'Клиент с таким кодом не найден' });
        customerId = c.id;
      }
      const weight = b.weight_kg === '' || b.weight_kg == null ? null : Number(b.weight_kg);
      const [[existing]] = await pool.query('SELECT id FROM cargo_parcels WHERE track_code = ?', [track]);
      if (existing) return res.status(409).json({ error: 'Такой трек-код уже есть — найдите его в списке и измените статус' });
      const [r] = await pool.query(
        'INSERT INTO cargo_parcels (customer_id, track_code, description, status, weight_kg) VALUES (?, ?, ?, ?, ?)',
        [customerId, track, b.description ? String(b.description).slice(0, 255) : null, status, weight]
      );
      await addEvent(r.insertId, status, 'Принято на складе');
      res.json({ id: r.insertId });
    } catch (e) {
      console.error('Ошибка приёма посылки:', e);
      res.status(500).json({ error: 'Не удалось добавить посылку' });
    }
  });

  app.patch('/api/admin/cargo/parcels/:id', requireAuth, async (req, res) => {
    const b = req.body || {};
    try {
      const [[p]] = await pool.query('SELECT * FROM cargo_parcels WHERE id = ?', [req.params.id]);
      if (!p) return res.status(404).json({ error: 'Посылка не найдена' });

      const sets = [];
      const params = [];
      let newStatus = null;

      if (b.status != null) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Неверный статус' });
        if (b.status !== p.status) { sets.push('status = ?'); params.push(b.status); newStatus = b.status; }
      }
      let weight = p.weight_kg;
      if (b.weight_kg !== undefined) {
        weight = b.weight_kg === '' || b.weight_kg === null ? null : Number(b.weight_kg);
        if (weight !== null && (!Number.isFinite(weight) || weight < 0)) return res.status(400).json({ error: 'Неверный вес' });
        sets.push('weight_kg = ?'); params.push(weight);
      }
      if (b.price !== undefined) {
        const price = b.price === '' || b.price === null ? null : Number(b.price);
        if (price !== null && (!Number.isFinite(price) || price < 0)) return res.status(400).json({ error: 'Неверная цена' });
        sets.push('price = ?'); params.push(price);
      } else if (b.weight_kg !== undefined && weight !== null && p.price == null) {
        // цена ещё не задана — считаем автоматически: вес × цена за кг
        const perKg = Number(await getSetting('price_per_kg', 0)) || 0;
        if (perKg > 0) { sets.push('price = ?'); params.push(Math.round(weight * perKg * 100) / 100); }
      }
      if (b.paid !== undefined) { sets.push('paid = ?'); params.push(b.paid ? 1 : 0); }
      if (b.description !== undefined) { sets.push('description = ?'); params.push(String(b.description || '').slice(0, 255) || null); }
      if (b.cargo_code !== undefined) {
        const code = String(b.cargo_code || '').trim().toUpperCase();
        if (code) {
          const [[c]] = await pool.query('SELECT id FROM cargo_customers WHERE cargo_code = ?', [code]);
          if (!c) return res.status(404).json({ error: 'Клиент с таким кодом не найден' });
          sets.push('customer_id = ?'); params.push(c.id);
        } else { sets.push('customer_id = NULL'); }
      }
      if (b.delivery_requested !== undefined) { sets.push('delivery_requested = ?'); params.push(b.delivery_requested ? 1 : 0); }

      if (sets.length) {
        await pool.query(`UPDATE cargo_parcels SET ${sets.join(', ')} WHERE id = ?`, [...params, p.id]);
      }
      if (newStatus) await addEvent(p.id, newStatus, b.note ? String(b.note).slice(0, 255) : null);
      res.json({ ok: true });
    } catch (e) {
      console.error('Ошибка обновления посылки:', e);
      res.status(500).json({ error: 'Не удалось сохранить' });
    }
  });

  app.delete('/api/admin/cargo/parcels/:id', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM cargo_parcels WHERE id = ?', [req.params.id]);
      await pool.query('DELETE FROM cargo_parcel_events WHERE parcel_id = ?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось удалить' });
    }
  });

  // сводка для экрана «Обзор»
  app.get('/api/admin/cargo/summary', requireAuth, async (req, res) => {
    try {
      const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n FROM cargo_parcels GROUP BY status');
      const [[noOwner]] = await pool.query('SELECT COUNT(*) AS n FROM cargo_parcels WHERE customer_id IS NULL');
      const [[delivery]] = await pool.query("SELECT COUNT(*) AS n FROM cargo_parcels WHERE delivery_requested = 1 AND status NOT IN ('delivered','lost')");
      const [[unpaid]] = await pool.query('SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS sum FROM cargo_parcels WHERE price IS NOT NULL AND paid = 0');
      const [[paid30]] = await pool.query("SELECT COALESCE(SUM(price),0) AS sum, COUNT(*) AS n FROM cargo_parcels WHERE paid = 1 AND updated_at >= NOW() - INTERVAL 30 DAY");
      const [[kg30]] = await pool.query("SELECT COALESCE(SUM(weight_kg),0) AS kg FROM cargo_parcels WHERE weight_kg IS NOT NULL AND created_at >= NOW() - INTERVAL 30 DAY");
      const [[clients]] = await pool.query('SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS balances, SUM(created_at >= NOW() - INTERVAL 7 DAY) AS new7 FROM cargo_customers');
      const [[topups]] = await pool.query("SELECT COALESCE(SUM(amount),0) AS sum FROM cargo_wallet_tx WHERE kind = 'topup' AND created_at >= NOW() - INTERVAL 30 DAY");
      const [events] = await pool.query(
        `SELECT e.status, e.note, e.created_at, p.id AS parcel_id, p.track_code, c.name AS customer_name, c.cargo_code
           FROM cargo_parcel_events e JOIN cargo_parcels p ON p.id = e.parcel_id
           LEFT JOIN cargo_customers c ON c.id = p.customer_id
          ORDER BY e.id DESC LIMIT 15`
      );
      const counts = {};
      byStatus.forEach(r => { counts[r.status] = Number(r.n); });
      res.json({
        counts,
        no_owner: Number(noOwner.n),
        delivery_requests: Number(delivery.n),
        unpaid_count: Number(unpaid.n), unpaid_sum: Number(unpaid.sum),
        paid_30d: Number(paid30.sum), paid_30d_count: Number(paid30.n),
        kg_30d: Number(kg30.kg),
        clients: Number(clients.n), clients_new_7d: Number(clients.new7 || 0), balances: Number(clients.balances),
        topups_30d: Number(topups.sum),
        events,
      });
    } catch (e) {
      console.error('Ошибка сводки карго:', e);
      res.status(500).json({ error: 'Не удалось получить сводку' });
    }
  });

  // массовая смена статуса (например, вся партия ушла «в путь»)
  app.post('/api/admin/cargo/parcels/bulk', requireAuth, async (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Boolean).slice(0, 1000) : [];
    const status = (req.body || {}).status;
    const note = String((req.body || {}).note || '').slice(0, 255) || null;
    if (!ids.length) return res.status(400).json({ error: 'Не выбраны посылки' });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Неверный статус' });
    try {
      const [rows] = await pool.query(`SELECT id FROM cargo_parcels WHERE id IN (${ids.map(() => '?').join(',')}) AND status <> ?`, [...ids, status]);
      if (rows.length) {
        const changed = rows.map(r => r.id);
        await pool.query(`UPDATE cargo_parcels SET status = ? WHERE id IN (${changed.map(() => '?').join(',')})`, [status, ...changed]);
        await pool.query(
          `INSERT INTO cargo_parcel_events (parcel_id, status, note) VALUES ${changed.map(() => '(?, ?, ?)').join(',')}`,
          changed.flatMap(id => [id, status, note])
        );
      }
      res.json({ ok: true, changed: rows.length });
    } catch (e) {
      console.error('Ошибка массового обновления:', e);
      res.status(500).json({ error: 'Не удалось обновить' });
    }
  });

  // приёмка пачкой: список трек-кодов (со сканера или вставкой) → статус; неизвестные создаются без владельца
  app.post('/api/admin/cargo/receive', requireAuth, async (req, res) => {
    const raw = (req.body || {}).tracks;
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/)).map(normTrack).filter(Boolean);
    const tracks = [...new Set(list)].slice(0, 1000);
    const status = STATUSES.includes((req.body || {}).status) ? req.body.status : 'warehouse';
    if (!tracks.length) return res.status(400).json({ error: 'Нет трек-кодов' });
    const result = { updated: [], created: [], same: [], invalid: [] };
    try {
      for (const t of tracks) {
        if (!/^[A-Z0-9\-_.]{5,60}$/.test(t)) { result.invalid.push(t); continue; }
        const [[p]] = await pool.query('SELECT id, status FROM cargo_parcels WHERE track_code = ?', [t]);
        if (p) {
          if (p.status === status) { result.same.push(t); continue; }
          await pool.query('UPDATE cargo_parcels SET status = ? WHERE id = ?', [status, p.id]);
          await addEvent(p.id, status, null);
          result.updated.push(t);
        } else {
          const [r] = await pool.query('INSERT INTO cargo_parcels (track_code, status) VALUES (?, ?)', [t, status]);
          await addEvent(r.insertId, status, 'Принято без владельца');
          result.created.push(t);
        }
      }
      res.json(result);
    } catch (e) {
      console.error('Ошибка приёмки:', e);
      res.status(500).json({ error: 'Не удалось принять посылки' });
    }
  });

  app.get('/api/admin/cargo/parcels/:id/events', requireAuth, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT status, note, created_at FROM cargo_parcel_events WHERE parcel_id = ? ORDER BY id DESC', [req.params.id]);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить историю' });
    }
  });

  // карточка клиента: данные + посылки + операции кошелька
  app.get('/api/admin/cargo/customers/:id', requireAuth, async (req, res) => {
    try {
      const [[c]] = await pool.query(
        `SELECT c.id, c.name, c.phone, c.cargo_code, c.balance, c.created_at, c.pickup_point_id, pp.name AS pickup_name
           FROM cargo_customers c LEFT JOIN cargo_pickup_points pp ON pp.id = c.pickup_point_id WHERE c.id = ?`, [req.params.id]);
      if (!c) return res.status(404).json({ error: 'Клиент не найден' });
      const [parcels] = await pool.query('SELECT * FROM cargo_parcels WHERE customer_id = ? ORDER BY updated_at DESC', [c.id]);
      const [tx] = await pool.query('SELECT * FROM cargo_wallet_tx WHERE customer_id = ? ORDER BY id DESC LIMIT 200', [c.id]);
      res.json({ customer: c, parcels, transactions: tx });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить клиента' });
    }
  });

  // все операции кошельков (пополнения, оплаты, корректировки)
  app.get('/api/admin/cargo/transactions', requireAuth, async (req, res) => {
    const { q, kind } = req.query;
    const where = [];
    const params = [];
    if (kind && ['topup', 'payment', 'adjust'].includes(kind)) { where.push('t.kind = ?'); params.push(kind); }
    if (q) { const like = '%' + String(q).trim() + '%'; where.push('(c.cargo_code LIKE ? OR c.phone LIKE ? OR c.name LIKE ? OR t.note LIKE ?)'); params.push(like, like, like, like); }
    try {
      const [rows] = await pool.query(
        `SELECT t.*, c.name AS customer_name, c.cargo_code, c.phone AS customer_phone
           FROM cargo_wallet_tx t JOIN cargo_customers c ON c.id = t.customer_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY t.id DESC LIMIT 500`, params);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить операции' });
    }
  });

  app.get('/api/admin/cargo/customers', requireAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = '%' + q + '%';
    try {
      const [rows] = await pool.query(
        `SELECT c.id, c.name, c.phone, c.cargo_code, c.balance, c.created_at, pp.name AS pickup_name, COUNT(p.id) AS parcels,
                SUM(p.status NOT IN ('delivered','lost')) AS active_parcels
           FROM cargo_customers c
           LEFT JOIN cargo_parcels p ON p.customer_id = c.id
           LEFT JOIN cargo_pickup_points pp ON pp.id = c.pickup_point_id
          ${q ? 'WHERE c.cargo_code LIKE ? OR c.phone LIKE ? OR c.name LIKE ?' : ''}
          GROUP BY c.id ORDER BY c.id DESC LIMIT 500`, q ? [like, like, like] : []
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить клиентов' });
    }
  });

  // пополнить (или скорректировать) кошелёк клиента — после того, как деньги получены наличными/переводом
  app.post('/api/admin/cargo/customers/:id/wallet', requireAuth, async (req, res) => {
    const amount = Math.round(Number((req.body || {}).amount) * 100) / 100;
    const note = String((req.body || {}).note || '').trim().slice(0, 255);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) return res.status(400).json({ error: 'Укажите сумму' });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[c]] = await conn.query('SELECT id, balance FROM cargo_customers WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!c) { await conn.rollback(); return res.status(404).json({ error: 'Клиент не найден' }); }
      if (Number(c.balance) + amount < 0) { await conn.rollback(); return res.status(400).json({ error: 'Баланс не может стать отрицательным' }); }
      await conn.query('UPDATE cargo_customers SET balance = balance + ? WHERE id = ?', [amount, c.id]);
      await conn.query(
        'INSERT INTO cargo_wallet_tx (customer_id, amount, kind, note) VALUES (?, ?, ?, ?)',
        [c.id, amount, amount > 0 ? 'topup' : 'adjust', note || (amount > 0 ? 'Пополнение' : 'Корректировка')]
      );
      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      console.error('Ошибка пополнения кошелька:', e);
      res.status(500).json({ error: 'Не удалось изменить баланс' });
    } finally {
      conn.release();
    }
  });

  // админ задаёт клиенту новый пароль (клиент забыл пароль и написал в поддержку)
  app.post('/api/admin/cargo/customers/:id/password', requireAuth, async (req, res) => {
    const pass = String((req.body || {}).password || '');
    if (pass.length < 6) return res.status(400).json({ error: 'Пароль — минимум 6 символов' });
    try {
      const [r] = await pool.query('UPDATE cargo_customers SET password_hash = ? WHERE id = ?', [await bcrypt.hash(pass, 10), req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Клиент не найден' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось сменить пароль' });
    }
  });

  app.get('/api/admin/cargo/pickup-points', requireAuth, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM cargo_pickup_points ORDER BY sort_order, id');
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить пункты выдачи' });
    }
  });

  app.post('/api/admin/cargo/pickup-points', requireAuth, async (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 120);
    const address = String((req.body || {}).address || '').trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: 'Укажите название' });
    try {
      const [[{ m }]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cargo_pickup_points');
      const [r] = await pool.query('INSERT INTO cargo_pickup_points (name, address, sort_order) VALUES (?, ?, ?)', [name, address || null, m + 1]);
      res.json({ id: r.insertId });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось добавить' });
    }
  });

  app.delete('/api/admin/cargo/pickup-points/:id', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM cargo_pickup_points WHERE id = ?', [req.params.id]);
      await pool.query('UPDATE cargo_customers SET pickup_point_id = NULL WHERE pickup_point_id = ?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось удалить' });
    }
  });

  return { ensureCargoTables };
};
