// ----------------------------------------------------------------------------
// ВИТРИНА МАРКЕТА: публичные страницы продавцов + «примерка» товара на манекене.
// Продавец = партнёр из раздела «Партнёры» админки (там же учёт комиссий и выплат).
// Публичными становятся только поля витрины и только при галочке «показывать на сайте».
// ----------------------------------------------------------------------------

const TRYON_SLOTS = ['top', 'bottom', 'dress', 'outer', 'shoes'];

module.exports = function registerStorefront({ app, pool, requireAuth }) {
  async function ensureColumn(table, column, definition) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
      [table, column]
    );
    if (rows[0].cnt === 0) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async function ensureStorefrontColumns() {
    await ensureColumn('partners', 'shop_name', 'VARCHAR(120) NULL');
    await ensureColumn('partners', 'shop_about', 'TEXT NULL');
    await ensureColumn('partners', 'shop_logo', 'MEDIUMTEXT NULL');
    await ensureColumn('partners', 'shop_instagram', 'VARCHAR(120) NULL');
    await ensureColumn('partners', 'shop_public', 'TINYINT(1) NOT NULL DEFAULT 0');
    // в какую зону манекена «надевается» товар: top / bottom / dress / outer / shoes (пусто — не примеряется)
    await ensureColumn('products', 'tryon_slot', 'VARCHAR(10) NULL');
    console.log('Поля витрины продавцов готовы.');
  }

  // публичный список продавцов (только с включённой витриной)
  app.get('/api/sellers', async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT p.id, COALESCE(NULLIF(p.shop_name, ''), p.name) AS name, p.shop_about AS about, p.shop_logo AS logo,
                p.shop_instagram AS instagram, COUNT(pr.id) AS products
           FROM partners p LEFT JOIN products pr ON pr.partner_id = p.id AND pr.active = 1
          WHERE p.shop_public = 1 AND p.active = 1
          GROUP BY p.id ORDER BY products DESC, p.id`
      );
      res.json(rows.map(r => ({ ...r, products: Number(r.products) || 0 })));
    } catch (e) {
      console.error('Ошибка списка продавцов:', e);
      res.status(500).json({ error: 'Не удалось получить продавцов' });
    }
  });

  // витрина продавца (админка): название, описание, логотип, instagram, показывать ли на сайте
  app.patch('/api/partners/:id/shop', requireAuth, async (req, res) => {
    const b = req.body || {};
    const sets = [];
    const vals = [];
    if (b.shop_name !== undefined) { sets.push('shop_name = ?'); vals.push(String(b.shop_name || '').trim().slice(0, 120) || null); }
    if (b.shop_about !== undefined) { sets.push('shop_about = ?'); vals.push(String(b.shop_about || '').trim().slice(0, 2000) || null); }
    if (b.shop_instagram !== undefined) { sets.push('shop_instagram = ?'); vals.push(String(b.shop_instagram || '').trim().replace(/^@/, '').slice(0, 120) || null); }
    if (b.shop_public !== undefined) { sets.push('shop_public = ?'); vals.push(b.shop_public ? 1 : 0); }
    if (b.shop_logo !== undefined) {
      const logo = b.shop_logo ? String(b.shop_logo) : null;
      if (logo && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(logo)) return res.status(400).json({ error: 'Логотип должен быть картинкой' });
      if (logo && logo.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Логотип слишком большой' });
      sets.push('shop_logo = ?'); vals.push(logo);
    }
    if (!sets.length) return res.json({ ok: true });
    try {
      const [r] = await pool.query(`UPDATE partners SET ${sets.join(', ')} WHERE id = ?`, [...vals, req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Партнёр не найден' });
      res.json({ ok: true });
    } catch (e) {
      console.error('Ошибка витрины продавца:', e);
      res.status(500).json({ error: 'Не удалось сохранить витрину' });
    }
  });

  // зона примерки товара на манекене
  app.patch('/api/products/:id/tryon', requireAuth, async (req, res) => {
    const slot = (req.body || {}).tryon_slot || null;
    if (slot && !TRYON_SLOTS.includes(slot)) return res.status(400).json({ error: 'Неверная зона примерки' });
    try {
      await pool.query('UPDATE products SET tryon_slot = ? WHERE id = ?', [slot, req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Не удалось сохранить' });
    }
  });

  return { ensureStorefrontColumns };
};
