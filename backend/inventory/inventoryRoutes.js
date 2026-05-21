const express = require('express');
const router = express.Router();
const ctrl = require('./inventoryController');
const roleAuth = require('../middleware/roleAuth');

router.get('/', roleAuth('admin'), ctrl.listInventory);
router.post('/', roleAuth('admin'), ctrl.createInventoryItem);
router.put('/:id', roleAuth('admin'), ctrl.updateInventoryItem);

module.exports = router;
