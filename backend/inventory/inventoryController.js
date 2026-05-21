const pool = require('../db');

exports.listInventory = async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM inventory_items ORDER BY name ASC');
    return res.json(q.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory' });
  }
};

exports.createInventoryItem = async (req, res) => {
  const { name, category, stock, reorder_level, unit } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const q = await pool.query(
      `INSERT INTO inventory_items (name, category, stock, reorder_level, unit)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [name, category || null, Number(stock || 0), Number(reorder_level || 0), unit || null]
    );
    return res.json({ message: 'Inventory item created', item: q.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create inventory item' });
  }
};

exports.updateInventoryItem = async (req, res) => {
  const itemId = Number(req.params.id);
  const { name, category, stock, reorder_level, unit } = req.body;
  if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid item id' });

  try {
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push(`name=$${values.length + 1}`);
      values.push(name);
    }
    if (category !== undefined) {
      updates.push(`category=$${values.length + 1}`);
      values.push(category);
    }
    if (stock !== undefined) {
      updates.push(`stock=$${values.length + 1}`);
      values.push(Number(stock));
    }
    if (reorder_level !== undefined) {
      updates.push(`reorder_level=$${values.length + 1}`);
      values.push(Number(reorder_level));
    }
    if (unit !== undefined) {
      updates.push(`unit=$${values.length + 1}`);
      values.push(unit);
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
    console.error(error);
    return res.status(500).json({ error: 'Failed to update inventory item' });
  }
};
