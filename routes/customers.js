const express = require('express');
const Customer = require('../models/Customers');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { escapeRegex, parsePagination, sortAndPaginate } = require('../lib/query');
const { roundMoney } = require('../lib/money');
const { logAudit } = require('../lib/auditLog');
const { isValidEmail, isValidPhone } = require('../lib/validators');
const { generateCustomerID } = require('../lib/customerID');

const router = express.Router();

router.get('/api/customers', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'customerName', sortDir = 'asc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
      $or: [
        { customerID: { $regex: escapeRegex(search), $options: 'i' } },
        { customerName: { $regex: escapeRegex(search), $options: 'i' } },
        { mobileNo: { $regex: escapeRegex(search), $options: 'i' } },
        { email: { $regex: escapeRegex(search), $options: 'i' } },
      ],
    }
    : {};

  const data = await Customer.find(
    filter,
    'customerID customerName mobileNo emergencyMobile email address orders accountBalance'
  );

  const mapped = data.map((c) => {
    const accountBalance = roundMoney(c.accountBalance || 0);

    return {
      _id: c._id,
      customerID: c.customerID,
      customerName: c.customerName,
      mobileNo: c.mobileNo,
      emergencyMobile: c.emergencyMobile,
      email: c.email,
      address: c.address,
      orders: c.orders,
      accountBalance,
      totalBalanceDue: Math.max(0, accountBalance),
      creditBalance: Math.max(0, roundMoney(-accountBalance)),
    };
  });

  const { data: customers, total } = sortAndPaginate(mapped, {
    sortBy,
    sortDir,
    page,
    limit,
  });

  res.json({ success: true, customers, total, page, limit });
}));

router.post('/customer/create', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
 let {
    customerName,
    mobileNo,
    emergencyMobile,
    email,
    address,
  } = req.body;

  if (!customerName || customerName.trim() === '') {
    return res.status(400).json({
      success: false,
      message: 'Customer name is required',
    });
  }

  customerName = customerName.trim().replace(/\s+/g, ' ');
  mobileNo = mobileNo ? mobileNo.trim() : '';
  emergencyMobile = emergencyMobile ? emergencyMobile.trim() : '';
  email = email ? email.trim() : '';
  address = address ? address.trim() : '';

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "That email address doesn't look right.",
    });
  }

  if (!isValidPhone(mobileNo) || !isValidPhone(emergencyMobile)) {
    return res.status(400).json({
      success: false,
      message: "That phone number doesn't look right.",
    });
  }

  const existingCustomer = await Customer.findOne({ customerName });

  if (existingCustomer) {
    return res.status(400).json({
      success: false,
      message: 'Customer already exists',
    });
  }

  // Generate the next customer ID on the server.
  const lastCustomer = await Customer.findOne({})
    .sort({ customerID: -1 })
    .select('customerID')
    .lean();

  let nextNumber = 1;

  if (lastCustomer?.customerID) {
    const lastNumber = parseInt(
      lastCustomer.customerID.replace('#', ''),
      10
    );

    if (Number.isFinite(lastNumber)) {
      nextNumber = lastNumber + 1;
    }
  }

  const customerID = `#${String(nextNumber).padStart(4, '0')}`;

  const newCustomer = new Customer({
    customerID,
    customerName,
    mobileNo,
    emergencyMobile,
    email,
    address,
    orders: [],
    accountBalance: 0,
  });

  await newCustomer.save();

  res.status(201).json({
    success: true,
    message: 'Customer added successfully',
    customer: newCustomer,
  });
}));


router.post('/customer/updateCustomer', requireAuth, asyncHandler(async (req, res) => {
  console.log('\n========== CUSTOMER UPDATE START ==========');
  console.log('[1] Request body:', req.body);

  let {
    customerName,
    mobileNo,
    emergencyMobile,
    email,
    address,
    paymentAmount,
  } = req.body;

  if (!customerName || customerName.trim() === '') {
    console.log('[ERROR] Customer name missing');

    return res.status(400).json({
      success: false,
      message: 'Customer name is required',
    });
  }

  customerName = customerName.trim().replace(/\s+/g, ' ');
  mobileNo = mobileNo ? mobileNo.trim() : '';
  emergencyMobile = emergencyMobile ? emergencyMobile.trim() : '';
  email = email ? email.trim() : '';
  address = address ? address.trim() : '';

  console.log('[2] Normalized customer:', customerName);
  console.log('[3] paymentAmount received:', paymentAmount);
  console.log('[3] paymentAmount type:', typeof paymentAmount);

  if (!isValidEmail(email)) {
    console.log('[ERROR] Invalid email');

    return res.status(400).json({
      success: false,
      message: 'That email address doesn\'t look right.',
    });
  }

 

  const amount =
    paymentAmount === undefined || paymentAmount === ''
      ? 0
      : Number(paymentAmount);

  console.log('[4] Parsed payment amount:', amount);

  if (!Number.isFinite(amount) || amount < 0) {
    console.log('[ERROR] Invalid payment amount:', amount);

    return res.status(400).json({
      success: false,
      message: 'Payment amount must be a valid non-negative amount.',
    });
  }

  const beforeCustomer = await Customer.findOne({ customerName });

  if (!beforeCustomer) {
    console.log('[ERROR] Customer not found:', customerName);

    return res.status(404).json({
      success: false,
      message: 'Customer not found',
    });
  }

  console.log('[5] Customer BEFORE update:', {
    id: beforeCustomer._id.toString(),
    name: beforeCustomer.customerName,
    accountBalance: beforeCustomer.accountBalance,
  });

  // Positive balance = customer owes us.
  // Payment reduces that balance.
  //
  // Negative balance = customer has credit.
  // Payment consumes that credit.
  const rawBalance = beforeCustomer.accountBalance;

  const currentBalance = roundMoney(
    Number(rawBalance) || 0
  );

  console.log('[BALANCE 1] Mongo value BEFORE update:', rawBalance);
  console.log('[BALANCE 2] Mongo value type:', typeof rawBalance);
  console.log('[BALANCE 3] Parsed current balance:', currentBalance);
  console.log('[BALANCE 4] Payment amount:', amount);
  console.log('[BALANCE 5] Payment amount type:', typeof amount);

  const newBalance =
    currentBalance >= 0
      ? roundMoney(currentBalance - amount)
      : roundMoney(currentBalance + amount);

  console.log('[BALANCE 6] CALCULATED NEW BALANCE:', newBalance);

  console.log('[BALANCE 7] About to write to MongoDB:', {
    customerId: beforeCustomer._id.toString(),
    customerName: beforeCustomer.customerName,
    accountBalance: newBalance,
  });

  const updatedCustomer = await Customer.findOneAndUpdate(
    { _id: beforeCustomer._id },
    {
      $set: {
        mobileNo,
        emergencyMobile,
        email,
        address,
        accountBalance: newBalance,
      },
    },
    {
      new: true,
      runValidators: true,
    }
  );

  console.log('[BALANCE 8] findOneAndUpdate returned:', {
    id: updatedCustomer?._id?.toString(),
    customerName: updatedCustomer?.customerName,
    accountBalance: updatedCustomer?.accountBalance,
  });

  if (!updatedCustomer) {
    console.log('[ERROR] MongoDB update returned null');

    return res.status(404).json({
      success: false,
      message: 'Customer could not be updated',
    });
  }

  const verifyCustomer = await Customer.findById(
    beforeCustomer._id
  )
    .select('_id customerName accountBalance')
    .lean();

  console.log(
    '[BALANCE 9] DIRECT MongoDB READ AFTER UPDATE:',
    verifyCustomer
  );

  console.log('[BALANCE 10] Expected balance:', newBalance);
  console.log(
    '[BALANCE 11] Actual Mongo balance:',
    verifyCustomer?.accountBalance
  );

  console.log(
    '[BALANCE 12] MATCH:',
    Number(verifyCustomer?.accountBalance) === Number(newBalance)
  );

  console.log('========== BALANCE DEBUG END ==========\n');

  await logAudit({
    action: 'customer.updated',
    actor: {
      username: req.user.username,
      role: req.user.role,
    },
    targetType: 'customer',
    targetId: beforeCustomer.customerName,
    before: beforeCustomer.toObject(),
    after: updatedCustomer.toObject(),
  });

  console.log('[9] Sending response:', {
    accountBalance: updatedCustomer.accountBalance,
  });

  console.log('========== CUSTOMER UPDATE END ==========\n');

  res.status(200).json({
    success: true,
    message: 'Customer updated successfully',
    customer: updatedCustomer,
  });
}));

router.post('/customer/deleteCustomer', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { customerName, force } = req.body;

  if (!customerName || customerName.trim() === '') {
    return res.status(400).json({
      success: false,
      message: 'Customer name is required',
    });
  }

  const customer = await Customer.findOne({
    customerName: {
      $regex: new RegExp(`^${customerName.trim()}$`, 'i'),
    },
  });

  if (!customer) {
    return res.status(404).json({
      success: false,
      message: 'Customer not found',
    });
  }

  const totalBalanceDue = Math.max(
    0,
    roundMoney(customer.accountBalance || 0)
  );

  if (totalBalanceDue > 0 && force !== true) {
    return res.status(409).json({
      success: false,
      message: `This customer has an outstanding balance of ${totalBalanceDue}. Pass force: true to delete anyway.`,
      totalBalanceDue,
      requiresForce: true,
    });
  }

  const deletedCustomer = await Customer.findOneAndDelete({
    _id: customer._id,
  });

  await logAudit({
    action: 'customer.deleted',
    actor: {
      username: req.user.username,
      role: req.user.role,
    },
    targetType: 'customer',
    targetId: deletedCustomer.customerName,
    before: deletedCustomer.toObject(),
    after: null,
  });

  res.status(200).json({
    success: true,
    message: 'Customer deleted successfully',
    customer: deletedCustomer,
  });
}));

router.post('/customer/undoCustomer', requireAuth, asyncHandler(async (req, res) => {
  const {
    customerID,
    customerName,
    mobileNo,
    emergencyMobile,
    email,
    address,
    orders,
    accountBalance,
  } = req.body;

  const existing = await Customer.findOne({ customerName });

  if (existing) {
    return res.status(400).json({
      success: false,
      message: 'Customer already exists.',
    });
  }

  const newCustomer = new Customer({
    customerID,
    customerName,
    mobileNo,
    emergencyMobile,
    email,
    address,
    orders: orders || [],
    accountBalance: accountBalance || 0,
  });

  await newCustomer.save();

  await logAudit({
    action: 'customer.restored',
    actor: {
      username: req.user.username,
      role: req.user.role,
    },
    targetType: 'customer',
    targetId: customerID,
    before: null,
    after: newCustomer.toObject(),
  });

  res.status(200).json({
    success: true,
    message: 'Customer restored successfully',
    customer: newCustomer,
  });
}));

module.exports = router;

