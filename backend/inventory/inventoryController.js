const pool = require('../db');

function parsePagination(req, defaultLimit = 50, maxLimit = 100) {
  let limit = Number(req.query.limit ?? defaultLimit);
  let offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

function parseNonNegativeInt(value, field) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `${field} must be a non-negative integer` };
  }
  return { ok: true, value: n };
}

exports.listInventory = async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req);
    const lowStockOnly = String(req.query.low_stock ?? '').toLowerCase() === 'true'
      || String(req.query.low_stock ?? '') === '1';

    let q;
    if (lowStockOnly) {
      q = await pool.query(
        `SELECT *, updated_at FROM inventory_items
         WHERE stock <= reorder_level
         ORDER BY name ASC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    } else {
      q = await pool.query(
        'SELECT *, updated_at FROM inventory_items ORDER BY name ASC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
    }
    return res.json(q.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory' });
  }
};

exports.createInventoryItem = async (req, res) => {
  const { name, category, stock, reorder_level, unit, mrp, expiry_date } = req.body;
  const cleanName = name !== undefined && name !== null ? String(name).trim() : '';
  if (!cleanName) return res.status(400).json({ error: 'name is required' });

  const stockP = parseNonNegativeInt(stock ?? 0, 'stock');
  if (!stockP.ok) return res.status(400).json({ error: stockP.error });
  // Reorder threshold is optional now — defaults to 5 so low-stock alerts work
  // without forcing staff to think about it on every add.
  const reorderP = parseNonNegativeInt(reorder_level ?? 5, 'reorder_level');
  if (!reorderP.ok) return res.status(400).json({ error: reorderP.error });

  // Explicit guard: block negative stock even if DB lacks CHECK constraint.
  if (stockP.value < 0 || reorderP.value < 0) {
    return res.status(400).json({ error: 'stock and reorder_level must not be negative' });
  }

  let mrpVal = '0.00';
  if (mrp !== undefined && mrp !== null && String(mrp).trim() !== '') {
    const s = String(mrp).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return res.status(400).json({ error: 'mrp must be a non-negative amount with at most 2 decimals' });
    mrpVal = Number(s).toFixed(2);
  }
  let expiryVal = null;
  if (expiry_date !== undefined && expiry_date !== null && String(expiry_date).trim() !== '') {
    const d = new Date(expiry_date);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'expiry_date must be a valid date' });
    expiryVal = d.toISOString().slice(0, 10);
  }

  try {
    const q = await pool.query(
      `INSERT INTO inventory_items (name, category, stock, reorder_level, unit, mrp, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        cleanName,
        category !== undefined && category !== null ? String(category).trim() || null : null,
        stockP.value,
        reorderP.value,
        unit !== undefined && unit !== null ? String(unit).trim() || null : null,
        mrpVal,
        expiryVal,
      ]
    );
    return res.json({ message: 'Inventory item created', item: q.rows[0] });
  } catch (error) {
    // Map DB CHECK violations to 400 as well.
    if (error && error.code === '23514') {
      return res.status(400).json({ error: 'stock must not be negative' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create inventory item' });
  }
};

exports.updateInventoryItem = async (req, res) => {
  const itemId = Number(req.params.id);
  const { name, category, stock, reorder_level, unit, mrp, expiry_date, restock } = req.body;
  if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid item id' });

  try {
    const updates = [];
    const values = [];

    if (name !== undefined) {
      const clean = String(name).trim();
      if (!clean) return res.status(400).json({ error: 'name must not be empty' });
      updates.push(`name=$${values.length + 1}`);
      values.push(clean);
    }
    if (category !== undefined) {
      updates.push(`category=$${values.length + 1}`);
      values.push(category === null ? null : String(category).trim() || null);
    }
    // Restock: add to current stock instead of replacing it.
    if (restock !== undefined) {
      const n = Number(restock);
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'restock must be a positive integer' });
      updates.push(`stock=stock+$${values.length + 1}`);
      values.push(n);
    } else if (stock !== undefined) {
      const p = parseNonNegativeInt(stock, 'stock');
      if (!p.ok) return res.status(400).json({ error: p.error });
      if (p.value < 0) return res.status(400).json({ error: 'stock must not be negative' });
      updates.push(`stock=$${values.length + 1}`);
      values.push(p.value);
    }
    if (reorder_level !== undefined) {
      const p = parseNonNegativeInt(reorder_level, 'reorder_level');
      if (!p.ok) return res.status(400).json({ error: p.error });
      updates.push(`reorder_level=$${values.length + 1}`);
      values.push(p.value);
    }
    if (unit !== undefined) {
      updates.push(`unit=$${values.length + 1}`);
      values.push(unit === null ? null : String(unit).trim() || null);
    }
    if (mrp !== undefined) {
      const s = String(mrp).trim();
      if (s !== '' && !/^\d+(\.\d{1,2})?$/.test(s)) return res.status(400).json({ error: 'mrp must be a non-negative amount with at most 2 decimals' });
      updates.push(`mrp=$${values.length + 1}`);
      values.push(s === '' ? '0.00' : Number(s).toFixed(2));
    }
    if (expiry_date !== undefined) {
      if (expiry_date === null || String(expiry_date).trim() === '') {
        updates.push(`expiry_date=$${values.length + 1}`);
        values.push(null);
      } else {
        const d = new Date(expiry_date);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'expiry_date must be a valid date' });
        updates.push(`expiry_date=$${values.length + 1}`);
        values.push(d.toISOString().slice(0, 10));
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(itemId);
    const q = await pool.query(
      `UPDATE inventory_items SET ${updates.join(', ')}, updated_at=NOW() WHERE id=$${values.length} RETURNING *`,
      values
    );

    if (!q.rows.length) return res.status(404).json({ error: 'Inventory item not found' });
    return res.json({ message: 'Inventory item updated', item: q.rows[0] });
  } catch (error) {
    if (error && error.code === '23514') {
      return res.status(400).json({ error: 'stock must not be negative' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update inventory item' });
  }
};
