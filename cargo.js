// ----------------------------------------------------------------------------
// КАРГО: личный кабинет клиента (код + адрес склада в Китае + трек-коды посылок)
// и управление посылками в админке.
// Клиентские токены подписываются ОТДЕЛЬНЫМ секретом, поэтому клиентский токен
// никогда не пройдёт проверку requireAuth (админскую).
// ----------------------------------------------------------------------------

const STATUSES = ['expected', 'warehouse', 'transit', 'arrived', 'delivered', 'lost'];

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
    console.log('Таблицы карго готовы.');
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
        'SELECT id, name, phone, cargo_code FROM cargo_customers WHERE id = ?',
        [req.customerId]
      );
      if (!c) return res.status(401).json({ error: 'Аккаунт не найден' });
      const [parcels] = await pool.query(
        'SELECT id, track_code, description, status, weight_kg, price, paid, created_at, updated_at FROM cargo_parcels WHERE customer_id = ? ORDER BY updated_at DESC, id DESC',
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
      const template = await getSetting('address', DEFAULT_ADDRESS);
      res.json({
        customer: { name: c.name, phone: c.phone, code: c.cargo_code },
        address: template.split('{code}').join(c.cargo_code),
        price_per_kg: Number(await getSetting('price_per_kg', 0)) || 0,
        contact_phone: await getSetting('contact_phone', ''),
        parcels: parcels.map(p => ({ ...p, events: byParcel[p.id] || [] })),
      });
    } catch (e) {
      console.error('Ошибка кабинета карго:', e);
      res.status(500).json({ error: 'Не удалось загрузить кабинет' });
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
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось сохранить настройки' });
    }
  });

  app.get('/api/admin/cargo/parcels', requireAuth, async (req, res) => {
    const { status, q } = req.query;
    const where = [];
    const params = [];
    if (status && STATUSES.includes(status)) { where.push('p.status = ?'); params.push(status); }
    if (q) {
      const like = '%' + String(q).trim() + '%';
      where.push('(p.track_code LIKE ? OR c.cargo_code LIKE ? OR c.phone LIKE ? OR c.name LIKE ?)');
      params.push(like, like, like, like);
    }
    try {
      const [rows] = await pool.query(
        `SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, c.cargo_code
           FROM cargo_parcels p LEFT JOIN cargo_customers c ON c.id = p.customer_id
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

  app.get('/api/admin/cargo/customers', requireAuth, async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT c.id, c.name, c.phone, c.cargo_code, c.created_at, COUNT(p.id) AS parcels
           FROM cargo_customers c LEFT JOIN cargo_parcels p ON p.customer_id = c.id
          GROUP BY c.id ORDER BY c.id DESC LIMIT 500`
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Не удалось получить клиентов' });
    }
  });

  return { ensureCargoTables };
};
