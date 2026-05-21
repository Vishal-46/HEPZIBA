const express = require('express');
const router = express.Router();
const ctrl = require('./billingController');
const roleAuth = require('../middleware/roleAuth');

router.post('/invoices', roleAuth('admin'), ctrl.createInvoice);
router.get('/my', roleAuth('patient'), ctrl.getMyInvoices);
router.get('/invoices/:id', roleAuth(['admin', 'patient']), ctrl.getInvoiceById);

module.exports = router;
