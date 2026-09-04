import { useEffect, useMemo, useRef, useState } from 'react';

import { toast } from 'sonner';

import Sidebar from '../components/Sidebar';

import { useAuth } from '../lib/AuthContext';

import { useConfirm } from '../components/ConfirmDialog';

import { useSubmitGuard } from '../lib/useSubmitGuard';

import { api } from '../lib/api';

import { roundMoney, formatMoney, formatMoneyShort } from '../lib/money';

import { printReceipt, buildReceiptHtml } from '../lib/print';

import { SHOP_NAME, SHOP_ADDRESS, SHOP_PHONE } from '../lib/shopInfo';

import {
  isWebUSBSupported,
  getPairedPrinter,
  pairThermalPrinter,
  tryThermalPrint,
} from '../lib/thermalPrint';

import {
  isOfflineSyncEnabled,
  enqueueSale,
  saveLocalDraft,
  getLocalDraft,
  clearLocalDraft,
} from '../lib/offlineQueue';

import { isNetworkError, flushQueue } from '../lib/offlineSync';

const emailPattern = /^[^\s@]+\.[^\s@]+$/;

const emptyCustomerForm = {
  customerName: '',
  mobileNo: '',
  emergencyMobile: '',
  email: '',
  address: '',
};

const WALKIN_CUSTOMER = 'Walk-in / Unknown';

export default function Billing() {
  const { username, isAdmin } = useAuth();
  const confirm = useConfirm();
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [customerDirectory, setCustomerDirectory] = useState({});
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [customer, setCustomer] = useState('unknown');
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [customerForm, setCustomerForm] = useState(emptyCustomerForm);
  const [itemForm, setItemForm] = useState({
    productId: '',
    productName: '',
    retailPrice: '',
    unitPrice: '',
    costPrice: '',
    quantity: '',
  });
  const [billingItems, setBillingItems] = useState({});
  const [itemNo, setItemNo] = useState(0);
  const [view, setView] = useState('add');
  const [billId, setBillId] = useState(null);
  const [paid, setPaid] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const offlineSyncEnabled = isOfflineSyncEnabled();
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    if (!offlineSyncEnabled) return;
    const goOnline = () => {
      setIsOnline(true);
      flushQueue();
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [offlineSyncEnabled]);

  const [printerConnected, setPrinterConnected] = useState(false);

  // Prevent double-clicks from reserving stock or generating the same
  // bill twice (see lib/useSubmitGuard.js).
  const { submitting: addingToBill, guard: guardAddToBill } = useSubmitGuard();
  const { submitting: generatingBill, guard: guardGenerateBill } = useSubmitGuard();
  const webUSBSupported = isWebUSBSupported();

  useEffect(() => {
    if (!webUSBSupported) return;
    getPairedPrinter().then((device) => setPrinterConnected(!!device));
    const onChange = () =>
      getPairedPrinter().then((device) => setPrinterConnected(!!device));
    navigator.usb.addEventListener('connect', onChange);
    navigator.usb.addEventListener('disconnect', onChange);
    return () => {
      navigator.usb.removeEventListener('connect', onChange);
      navigator.usb.removeEventListener('disconnect', onChange);
    };
  }, [webUSBSupported]);

  const handleConnectPrinter = async () => {
    const device = await pairThermalPrinter();
    if (device) {
      setPrinterConnected(true);
      toast.success(
        `Thermal printer paired: ${device.productName || 'USB printer'}`
      );
    } else {
      toast.error(
        'No printer selected. Bills will use the manual print dialog.'
      );
    }
  };

  const chooseOverpaymentSettlement = (amount) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (choice) => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      toast(
        `Customer overpaid by ${formatMoney(amount)}. What should happen with the extra?`,
        {
          duration: Infinity,
          action: {
            label: 'Add to Balance',
            onClick: () => settle('balance'),
          },
          cancel: {
            label: 'Give Change',
            onClick: () => settle('change'),
          },
          onDismiss: () => settle('change'),
          onAutoClose: () => settle('change'),
        }
      );
    });

  const loadProducts = () =>
    api
      .getProducts({ limit: 1000 })
      .then((p) => setProducts(p.products || []))
      .catch((err) =>
        setError(err.message || 'Failed to load products')
      );

  const saveDraftNow = async (
    itemsOverride,
    custOverride,
    billIdOverride,
    overpaymentChoiceOverride
  ) => {
    const source = itemsOverride ?? billingItems;
    const itemsArr = Object.values(source).map((item) => ({
      productID: `#${item.productCode}`,
      productName: item.itemName,
      retailPrice: roundMoney(item.retailPrice),
      unitPrice: roundMoney(item.unitPrice),
      quantity: item.quantity,
    }));
    try {
      await api.saveDraft({
        billID:
          billIdOverride !== undefined ? billIdOverride : billId,
        customerName:
          custOverride !== undefined ? custOverride : customer,
        items: itemsArr,
        paidInput: parseFloat(paid) || 0,
        paymentMethod,
        overpaymentChoice:
          overpaymentChoiceOverride || 'change',
      });
    } catch (err) {
      console.error('Draft save failed:', err.message);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([
          loadProducts(),
          api.getCustomers().then((c) => {
            const rows = c.customers || [];
            setCustomers(rows.map((row) => row.customerName));
            setCustomerDirectory(
              Object.fromEntries(
                rows.map((row) => [
                  row.customerName,
                  {
                    mobileNo: row.mobileNo || '',
                    email: row.email || '',
                    address: row.address || '',
                    creditBalance: row.creditBalance || 0,
                    totalBalanceDue: row.totalBalanceDue || 0,
                  },
                ])
              )
            );
          }),
        ]);
      } catch (err) {
        setError(err.message || 'Failed to load billing data');
      }

      try {
        const local = await getLocalDraft();
        if (
          local &&

          Object.keys(local.billingItems || {}).length > 0
        ) {
          const count = Object.keys(local.billingItems).length;
          const resume = await confirm(
            `You have an unfinished bill with ${count} item(s) from earlier. Resume it?`
          );
          if (resume) {
            setBillingItems(local.billingItems);
            setItemNo(
              Math.max(
                0,
                ...Object.keys(local.billingItems).map(Number)
              )
            );
            setCustomer(local.customer || 'unknown');
            setBillId(local.billId || null);
            setPaid(local.paid || '');
            setPaymentMethod(local.paymentMethod || 'cash');
          } else {
            await clearLocalDraft();
          }
          return;
        }
      } catch (err) {
        console.error(
          'Failed to check for a local draft bill:',
          err.message
        );
      }

      try {
        const data = await api.getDraft();
        if (data.draft && data.draft.items?.length > 0) {
          const resume = await confirm(
            `You have an unfinished bill with ${data.draft.items.length} item(s) from earlier. Resume it?`
          );
          if (resume) {
            const restored = {};
            data.draft.items.forEach((item, idx) => {
              restored[idx + 1] = {
                productCode: item.productID.replace('#', ''),
                itemName: item.productName,
                retailPrice: item.retailPrice,
                unitPrice: item.unitPrice,
                quantity: item.quantity,
              };
            });
            setBillingItems(restored);
            setItemNo(data.draft.items.length);
            setCustomer(data.draft.customerName || 'unknown');
            setBillId(data.draft.billID || null);
            setPaid(
              data.draft.paidInput
                ? String(data.draft.paidInput)
                : ''
            );
            setPaymentMethod(
              data.draft.paymentMethod || 'cash'
            );
          } else {
            await api.discardDraft();
            await loadProducts();
          }
        }
      } catch (err) {
        console.error(
          'Failed to check for a draft bill:',
          err.message
        );
      }
    })();
  }, [confirm]);

  const draftSaveTimeout = useRef(null);

  useEffect(() => {
    if (Object.keys(billingItems).length === 0) return;
    if (draftSaveTimeout.current) {
      clearTimeout(draftSaveTimeout.current);
    }
    draftSaveTimeout.current = setTimeout(() => {
      saveDraftNow();
    }, 7000);
    return () => clearTimeout(draftSaveTimeout.current);
  }, [billingItems, customer, billId, paid, paymentMethod]);

  useEffect(() => {
    if (Object.keys(billingItems).length === 0) return;
    saveLocalDraft({
      billingItems,
      customer,
      billId,
      paid,
      paymentMethod,
    }).catch((err) =>
      console.error('Local draft save failed:', err.message)
    );
  }, [billingItems, customer, billId, paid, paymentMethod]);

  const billingItemsRef = useRef(billingItems);

  useEffect(() => {
    billingItemsRef.current = billingItems;
  }, [billingItems]);

  useEffect(() => {
    const releaseAllHeld = () => {
      const token = localStorage.getItem('pos.token');
      Object.values(billingItemsRef.current).forEach((item) => {
        if (item.offline) return;
        fetch('/billing/release', {
          method: 'POST',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            ...(token
              ? { Authorization: `Bearer ${token}` }
              : {}),
          },
          body: JSON.stringify({
            productId: `#${item.productCode}`,
            quantity: item.quantity,
          }),
        }).catch(() => { });
      });
    };

    window.addEventListener('beforeunload', releaseAllHeld);
    return () => {
      window.removeEventListener(
        'beforeunload',
        releaseAllHeld
      );
      releaseAllHeld();
    };
  }, []);

  const filteredProducts = useMemo(() => {
    if (!search) return products;
    const q = search.toLowerCase();
    return products.filter((p) =>
      p.productName.toLowerCase().startsWith(q)
    );
  }, [products, search]);

  const grandTotal = useMemo(() => {
    const total = Object.values(billingItems).reduce(
      (sum, item) =>
        sum + Number(item.unitPrice || 0) * Number(item.quantity || 0),
      0
    );
    return roundMoney(total);
  }, [billingItems]);

  const balance = useMemo(() => {
    const paidNum = parseFloat(paid) || 0;
    return roundMoney(paidNum - grandTotal);
  }, [paid, grandTotal]);

  const handleSelectProduct = (product) => {
    setSelectedProductId(product.productID);
    // No catalog selling price set — leave both fields blank instead of
    // defaulting to 0, so the cashier has to enter a real rate rather
    // than silently ringing the item up for free.
    const hasCatalogPrice = product.price != null;
    const currentPrice = hasCatalogPrice ? roundMoney(product.price) : '';
    setItemForm({
      productId: product.productID,
      productName: product.productName,
      retailPrice: currentPrice,
      unitPrice: currentPrice,
      costPrice: product.costPrice ?? 0,
      quantity: '',
    });
  };

  const handleAddToBill = guardAddToBill(async () => {
    if (!selectedProductId) {
      toast.error('Please select a product from the table first!');
      return;
    }

    const quantity = parseInt(itemForm.quantity);
    // Retail Price is a disabled, catalog-driven field — the cashier
    // never types into it directly. When the product has no catalog
    // selling price at all, itemForm.retailPrice is '' (see
    // handleSelectProduct) rather than a real number, so there's no
    // reference price to require or cap the sale against.
    const hasRetailPrice = itemForm.retailPrice !== '' && itemForm.retailPrice != null;
    const retailPrice = hasRetailPrice ? roundMoney(itemForm.retailPrice) : null;
    const unitPrice = roundMoney(itemForm.unitPrice);

    if (
      !itemForm.productName ||
      !Number.isFinite(unitPrice) ||
      unitPrice < 0 ||
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      toast.error('Please enter valid item details!');
      return;
    }

    if (retailPrice !== null && unitPrice > retailPrice) {
      toast.error('Unit Price cannot be greater than Retail Price.');
      return;
    }

    // From here on, retailPrice must be a real number: the receipt's
    // "Retail" column and Order.retailPrice (required, min 0) both need
    // one. When there's no catalog price to show, mirror the rate the
    // cashier actually charged rather than recording a false Rs 0.
    const effectiveRetailPrice = retailPrice !== null ? retailPrice : unitPrice;

    const product = products.find(
      (p) => p.productID === selectedProductId
    );

    if (!product) {
      toast.error('Invalid product selection!');
      return;
    }

    let reserved;

    try {
      reserved = await api.reserveStock(
        selectedProductId,
        quantity
      );
    } catch (err) {
      if (
        offlineSyncEnabled &&
        isNetworkError(err)
      ) {
        const alreadyInCart = Object.values(billingItems)
          .filter(
            (item) =>
              item.productCode ===
              selectedProductId.replace('#', '')
          )
          .reduce(
            (sum, item) => sum + item.quantity,
            0
          );

        const softAvailable =
          (product.available ??
            product.quantity -
            (product.reserved || 0)) -
          alreadyInCart;

        if (softAvailable < quantity) {
          toast.error(
            `Offline — based on the last known stock, only ${Math.max(
              softAvailable,
              0
            )} unit(s) of this item look available.`
          );
          return;
        }

        const nextItemNo = itemNo + 1;
        setItemNo(nextItemNo);
        setBillingItems((prev) => ({
          ...prev,
          [nextItemNo]: {
            productCode:
              selectedProductId.replace('#', ''),
            itemName: itemForm.productName,
            retailPrice: effectiveRetailPrice,
            unitPrice,
            quantity,
            offline: true,
          },
        }));

        setItemForm({
          productId: '',
          productName: '',
          retailPrice: '',
          unitPrice: '',
          costPrice: '',
          quantity: '',
        });

        setSelectedProductId(null);
        return;
      }

      toast.error(
        err.message ||
        'Could not reserve stock for this item.'
      );
      await loadProducts();
      return;
    }

    setProducts((prev) =>
      prev.map((p) =>
        p.productID === selectedProductId
          ? {
            ...p,
            quantity: reserved.quantity,
            reserved: reserved.reserved,
            available: reserved.available,
            lowStock:
              reserved.available <=
              (p.lowStockThreshold ?? 10),
          }
          : p
      )
    );

    const nextItemNo = itemNo + 1;
    setItemNo(nextItemNo);
    setBillingItems((prev) => ({
      ...prev,
      [nextItemNo]: {
        productCode:
          selectedProductId.replace('#', ''),
        itemName: itemForm.productName,
        retailPrice: effectiveRetailPrice,
        unitPrice,
        quantity,
      },
    }));

    setItemForm({
      productId: '',
      productName: '',
      retailPrice: '',
      unitPrice: '',
      costPrice: '',
      quantity: '',
    });

    setSelectedProductId(null);
  });

  const handlePreview = async () => {
    if (billId) {
      setView('preview');
      return;
    }

    try {
      // Offline: no server to allocate a real sequential number from, so
      // this is only ever a local, throwaway reference shown on the
      // "OFFLINE — PENDING SYNC" receipt — the real "INV-dddd" invoice
      // number is assigned once this sale actually syncs (see
      // lib/offlineSync.js's allocateOrderId). Not shown to the cashier
      // as "the" invoice number for that reason.
      if (offlineSyncEnabled && !isOnline) {
        const localPlaceholder =
          '#' +
          Math.floor(Math.random() * 10000)
            .toString()
            .padStart(4, '0');

        setBillId(localPlaceholder);
        setView('preview');
        return;
      }

      // Online: the real, sequential invoice number — allocated once,
      // atomically, server-side (lib/orderId.js). No more client-side
      // guessing/retry loop.
      const { invoiceId } = await api.nextInvoiceId();

      setBillId(invoiceId);

      await saveDraftNow(
        undefined,
        undefined,
        invoiceId
      );

      setView('preview');
    } catch (err) {
      toast.error(
        'Error generating bill id: ' + err.message
      );
    }
  };

  const removeItem = async (key) => {
    if (!(await confirm('Do you want to remove this item?'))) {
      return;
    }

    const item = billingItems[key];

    setBillingItems((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      if (item.offline) {
        return;
      }

      const released = await api.releaseStock(
        `#${item.productCode}`,
        item.quantity
      );

      setProducts((prev) =>
        prev.map((p) =>
          p.productID === `#${item.productCode}`
            ? {
              ...p,
              quantity:
                released.quantity ?? p.quantity,
              reserved:
                released.reserved ?? p.reserved,
              available:
                released.available ?? p.available,
            }
            : p
        )
      );
    } catch (err) {
      console.error(
        'Failed to release reserved stock:',
        err.message
      );
    }
  };

  const resetBill = () => {
    setBillingItems({});
    setItemNo(0);
    setBillId(null);
    setPaid('');
    setPaymentMethod('cash');
    setView('add');

    clearLocalDraft().catch((err) =>
      console.error(
        'Failed to clear local draft:',
        err.message
      )
    );
  };

  const handleCancel = async () => {
    await saveDraftNow();
    resetBill();

    try {
      await api.discardDraft();
    } catch (err) {
      console.error(
        'Failed to discard draft:',
        err.message
      );
    }

    await loadProducts();
  };

  const printReceiptFor = async (
    total,
    paidNum,
    offline = false,
    overpaymentChoice = 'change',
    savedOrder = null,
    receiptItems = null,
    receiptCustomer = null,
    receiptBillId = null,
    receiptOldBalance = null
  ) => {
    const itemsSource = receiptItems || Object.values(billingItems);
    const customerName = receiptCustomer || customer;
    const currentBillId = receiptBillId || billId;

    const isOverpaid = paidNum > total;
    const settlementLabel =
      paidNum < total
        ? 'Balance Due (Credit)'
        : isOverpaid &&
          overpaymentChoice === 'balance'
          ? 'Added to Customer Balance'
          : 'Change';

    const settlementAmount = formatMoney(
      Math.abs(paidNum - total)
    );

    // Account balance block (Old/Total/Cash Received/Net Balance) only
    // applies to a real, on-file customer — never Walk-in — and only
    // when the caller actually resolved a pre-sale balance for them.
    // receiptOldBalance is the customer's signed accountBalance as it
    // stood *before* this sale (positive = owed, negative = credit).
    const showAccountBalance =
      customerName !== WALKIN_CUSTOMER &&
      receiptOldBalance !== null &&
      receiptOldBalance !== undefined;

    const oldBalanceNum = showAccountBalance
      ? roundMoney(receiptOldBalance)
      : 0;
    const totalBalanceNum = roundMoney(oldBalanceNum + total);
    const netBalanceNum = roundMoney(totalBalanceNum - paidNum);

    const items = itemsSource.map((item) => {
      const subtotal = roundMoney(
        Number(item.unitPrice || 0) *
        Number(item.quantity || 0)
      );

      return {
        itemName: item.itemName,
        retailLabel: formatMoneyShort(
          roundMoney(item.retailPrice)
        ),
        rateLabel: formatMoneyShort(
          roundMoney(item.unitPrice)
        ),
        qty: item.quantity,
        subtotalLabel: formatMoneyShort(subtotal),
        totalLabel: formatMoneyShort(subtotal),
      };
    });

    if (webUSBSupported) {
      const printed = await tryThermalPrint({
        billId: currentBillId,
        offline,
        items: itemsSource.map((item) => ({
          itemName: item.itemName,
          quantity: item.quantity,
          retailPriceLabel: formatMoney(
            roundMoney(item.retailPrice)
          ),
          unitPriceLabel: formatMoney(
            roundMoney(item.unitPrice)
          ),
          totalLabel: formatMoney(
            roundMoney(
              Number(item.unitPrice || 0) *
              Number(item.quantity || 0)
            )
          ),
        })),
        totalLabel: formatMoney(total),
        paidLabel: formatMoney(paidNum),
        settlementLabel,
        settlementAmountLabel: settlementAmount,
        customer: customerName,
        showAccountBalance,
        oldBalanceLabel: formatMoney(oldBalanceNum),
        totalBalanceLabel: formatMoney(totalBalanceNum),
        cashReceivedLabel: formatMoney(paidNum),
        netBalanceLabel: formatMoney(netBalanceNum),
      });

      if (printed) {
        toast.success(
          'Printed to thermal printer.'
        );
        return;
      }
    }

    const html = buildReceiptHtml({
      shopName: SHOP_NAME,
      shopAddress: SHOP_ADDRESS,
      shopPhone: SHOP_PHONE,
      billId: currentBillId,
      offline,
      customerName:
        customerName === WALKIN_CUSTOMER
          ? 'Walk-in'
          : customerName,
      customerAddress:
        customerDirectory[customerName]?.address || '',
      items,
      grandTotalLabel: formatMoney(total),
      paidLabel: formatMoney(paidNum),
      settlementLabel,
      settlementAmountLabel: settlementAmount,
      showAccountBalance,
      oldBalanceLabel: formatMoney(oldBalanceNum),
      totalBalanceLabel: formatMoney(totalBalanceNum),
      cashReceivedLabel: formatMoney(paidNum),
      netBalanceLabel: formatMoney(netBalanceNum),
    });

    printReceipt(html);
  };

  const handleGenerateBill = guardGenerateBill(async () => {
    const total = grandTotal;
    const paidNum = parseFloat(paid) || 0;
    const receiptItems = Object.values(billingItems).map((item) => ({
      productCode: item.productCode,
      itemName: item.itemName,
      retailPrice: roundMoney(item.retailPrice),
      unitPrice: roundMoney(item.unitPrice),
      quantity: Number(item.quantity),
    }));
    const receiptCustomer = customer;
    const receiptBillId = billId;

    if (paidNum < 0) {
      toast.error(
        "Payment amount can't be negative."
      );
      return;
    }

    if (customer === 'unknown') {
      toast.error(
        'Please select a customer before generating the bill.'
      );
      return;
    }

    if (paidNum < total) {
      const shortfall = roundMoney(
        total - paidNum
      );

      const proceed = await confirm(
        `Customer is paying ${formatMoney(
          paidNum
        )} of ${formatMoney(
          total
        )}. ${formatMoney(
          shortfall
        )} will be recorded as a balance owed on their account. Continue?`
      );

      if (!proceed) return;
    }

    let overpaymentChoice = 'change';
    const overpaidAmount = roundMoney(
      paidNum - total
    );

    if (
      overpaidAmount > 0 &&
      customer !== WALKIN_CUSTOMER &&
      (!offlineSyncEnabled || isOnline)
    ) {
      overpaymentChoice =
        await chooseOverpaymentSettlement(
          overpaidAmount
        );
    }

    try {
      await saveDraftNow(
        undefined,
        undefined,
        undefined,
        overpaymentChoice
      );

      console.log('========== GENERATING BILL ==========');
      console.log('Bill ID:', billId);
      console.log('Customer:', customer);
      console.log('Items:', Object.values(billingItems).map((item) => ({
        productID: `#${item.productCode}`,
        productName: item.itemName,
        retailPrice: item.retailPrice,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        subtotal: roundMoney(item.unitPrice * item.quantity),
      })));
      console.log('Grand Total:', total);
      console.log('Paid:', paidNum);
      console.log('Payment Method:', paymentMethod);
      console.log('Overpayment Choice:', overpaymentChoice);
      console.log('Balance:', roundMoney(paidNum - total));
      console.log('======================================');

      const data = await api.saveOrder();

      if (!data.success) {
        toast.error(
          data.message ||
          'Order failed. Try again.'
        );
        return;
      }

      // data.customer is the customer document as it stood *before*
      // this order was applied (routes/billing.js reads it ahead of the
      // transaction) — exactly the "old balance" the receipt needs.
      // null for a Walk-in sale, which has no Customer document.
      const oldBalance = data.customer
        ? data.customer.accountBalance
        : null;

      await printReceiptFor(
        total,
        paidNum,
        false,
        overpaymentChoice,
        data.order,
        receiptItems,
        receiptCustomer,
        receiptBillId,
        oldBalance
      );

      toast.success(
        'Order saved successfully.'
      );

      resetBill();
      setCustomer('unknown');
      await loadProducts();
    } catch (err) {
      if (
        offlineSyncEnabled &&
        isNetworkError(err)
      ) {
        try {
          await enqueueSale({
            idempotencyKey:
              crypto.randomUUID(),
            clientBillID: billId,
            customerName: customer,
            items: receiptItems.map((item) => ({
              productID: `#${item.productCode}`,
              productName: item.itemName,
              retailPrice: item.retailPrice,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
            })),
            paidInput: paidNum,
            paymentMethod,
            createdOfflineAt:
              new Date().toISOString(),
          });

          // Offline: no server round-trip to get a fresh pre-sale
          // balance, so fall back to the locally cached directory
          // (last value synced from the server this session).
          const cachedCustomer =
            customerDirectory[receiptCustomer];
          const offlineOldBalance = cachedCustomer
            ? roundMoney(
              (cachedCustomer.totalBalanceDue || 0) -
              (cachedCustomer.creditBalance || 0)
            )
            : null;

          await printReceiptFor(
            total,
            paidNum,
            true,
            'change',
            null,
            receiptItems,
            receiptCustomer,
            receiptBillId,
            offlineOldBalance
          );

          toast.success(
            "No connection — this bill has been saved on this device and will sync automatically once you're back online."
          );

          resetBill();
          setCustomer('unknown');
        } catch (queueErr) {
          toast.error(
            'Could not save this bill, even offline: ' +
            queueErr.message
          );
        }

        return;
      }

      toast.error(
        'Error saving order: ' + err.message
      );
    }
  });

  const handleCustomerSelect = (value) => {
    if (value === 'New Customer') {
      setShowCustomerForm(true);
      setCustomer('unknown');
    } else {
      setCustomer(value);
    }
  };

  const handleAddNewCustomer = async (e) => {
    e.preventDefault();

    const {
      customerName,
      mobileNo,
      emergencyMobile,
      email,
      address,
    } = customerForm;

    if (
      !customerName &&
      !mobileNo &&
      !emergencyMobile &&
      !email &&
      !address
    ) {
      setShowCustomerForm(false);
      return;
    }

    if (email && !emailPattern.test(email)) {
      toast.error(
        'Please enter a valid email address.'
      );
      return;
    }

    const cleanName = customerName
      .trim()
      .replace(/\s+/g, ' ');

    try {
      const data = await api.addCustomer({
        customerName: cleanName,
        mobileNo,
        emergencyMobile,
        email,
        address,
      });

      if (data.success) {
        setCustomers((prev) => [
          ...prev,
          cleanName,
        ]);

        setCustomerDirectory((prev) => ({
          ...prev,
          [cleanName]: {
            mobileNo,
            email,
            address,
            creditBalance: 0,
            totalBalanceDue: 0,
          },
        }));

        setCustomer(cleanName);

        toast.success(
          'New customer added successfully!'
        );
      } else {
        toast.error(
          data.message ||
          'Failed to add new customer.'
        );
      }
    } catch (err) {
      toast.error(
        'Error adding customer: ' + err.message
      );
    } finally {
      setShowCustomerForm(false);
      setCustomerForm(emptyCustomerForm);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />

      <main className="flex-1 pl-14 pr-4 py-4 @min-[768px]:p-6 overflow-y-auto relative">
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <h1 className="text-2xl @min-[640px]:text-3xl @min-[768px]:text-4xl font-bold text-brand">
              Creating Invoice
            </h1>

            {webUSBSupported && (
              <button
                onClick={handleConnectPrinter}
                className={`text-sm px-3 py-1.5 rounded-lg border ${printerConnected
                  ? 'border-green-300 bg-green-50 text-green-700'
                  : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
              >
                {printerConnected
                  ? '🖨️ Thermal Printer Connected'
                  : '🖨️ Connect Thermal Printer'}
              </button>
            )}

            <select
              value={
                showCustomerForm
                  ? 'New Customer'
                  : customer
              }
              onChange={(e) =>
                handleCustomerSelect(
                  e.target.value
                )
              }
              className="border border-gray-300 rounded-lg px-3 py-2 w-full @min-[640px]:w-52 focus:ring-2 focus:ring-brand focus:outline-none"
            >
              <option value="unknown">
                Select Customer
              </option>

              <option value={WALKIN_CUSTOMER}>
                🚶 Walk-in / Unknown
              </option>

              {customers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}

              <option value="New Customer">
                + New customer
              </option>
            </select>
          </div>

          {error && (
            <p className="text-red-600 text-sm">
              {error}
            </p>
          )}

          {offlineSyncEnabled && !isOnline && (
            <div className="bg-amber-50 border border-amber-300 text-amber-800 text-sm rounded-lg px-4 py-2">
              You're offline. Bills can still be
              created — they'll be saved on this
              device and synced automatically once
              you're back online. Stock and prices
              will be re-checked at that point.
            </div>
          )}

          <div className="grid grid-cols-1 @min-[768px]:grid-cols-3 gap-6 @min-[768px]:h-[600px]">
            <div className="@min-[768px]:col-span-2 bg-white rounded-lg shadow p-4 @min-[768px]:overflow-y-auto">
              <input
                type="text"
                placeholder="Search Products"
                value={search}
                onChange={(e) =>
                  setSearch(e.target.value)
                }
                className="border border-gray-300 rounded-lg px-3 py-2 w-full mb-3 focus:ring-2 focus:ring-brand focus:outline-none"
              />

              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm border border-gray-200 rounded-lg overflow-hidden">
                  <thead className="bg-brand text-white">
                    <tr>
                      <th className="text-left p-2">
                        Code
                      </th>
                      <th className="text-left p-2">
                        Name
                      </th>
                      <th className="text-left p-2">
                        In Stock
                      </th>
                      <th className="text-left p-2">
                        Unit Price
                      </th>
                      <th className="text-left p-2">
                        Stock's Total
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredProducts.length ===
                      0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="p-2 text-center text-gray-500"
                        >
                          No products available
                        </td>
                      </tr>
                    ) : (
                      filteredProducts.map(
                        (product) => {
                          const available =
                            product.available ??
                            product.quantity -
                            (product.reserved ||
                              0);

                          const lowStock =
                            product.lowStock ??
                            available <=
                            (product.lowStockThreshold ??
                              10);

                          return (
                            <tr
                              key={
                                product.productID
                              }
                              onClick={() =>
                                handleSelectProduct(
                                  product
                                )
                              }
                              className={`cursor-pointer hover:bg-blue-50 ${selectedProductId ===
                                product.productID
                                ? 'bg-blue-100'
                                : ''
                                } ${lowStock
                                  ? 'bg-red-50'
                                  : ''
                                }`}
                            >
                              <td className="p-2">
                                {
                                  product.productID
                                }
                              </td>

                              <td className="p-2">
                                {
                                  product.productName
                                }
                              </td>

                              <td
                                className={`p-2 ${lowStock
                                  ? 'text-red-700 font-semibold'
                                  : ''
                                  }`}
                              >
                                {available}

                                {lowStock && (
                                  <span className="ml-1 text-xs font-normal">
                                    ⚠ low
                                  </span>
                                )}
                              </td>

                              <td className="p-2">
                                {product.price == null ? (
                                  <span className="text-gray-400">—</span>
                                ) : (
                                  formatMoney(product.price)
                                )}
                              </td>

                              <td className="p-2">
                                {product.price == null ? (
                                  <span className="text-gray-400">—</span>
                                ) : (
                                  formatMoney(product.price * available)
                                )}
                              </td>
                            </tr>
                          );
                        }
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {view === 'add' ? (
              <div className="@min-[768px]:overflow-y-auto bg-white rounded-lg shadow p-4 space-y-3">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-medium text-lg text-brand">
                    Add Product
                  </h3>

                  {billId && (
                    <h3>
                      <b className="text-brand-green">
                        Bill ID:
                      </b>{' '}

                      <span className="font-semibold text-lg">
                        {billId}
                      </span>
                    </h3>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">
                      Product ID
                    </label>

                    <input
                      type="text"
                      value={
                        itemForm.productId
                      }
                      disabled
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100"
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">
                      Product Name
                    </label>

                    <input
                      type="text"
                      value={
                        itemForm.productName
                      }
                      disabled
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100"
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">
                      Retail Price
                    </label>

                    <input
                      type="number"
                      value={
                        itemForm.retailPrice
                      }
                      disabled
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100"
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">
                      Unit Price
                    </label>

                    <input
                      type="number"
                      value={
                        itemForm.unitPrice
                      }
                      onChange={(e) =>
                        setItemForm({
                          ...itemForm,
                          unitPrice:
                            e.target.value,
                        })
                      }
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 focus:ring-2 focus:ring-brand focus:outline-none"
                    />
                  </div>

                  {isAdmin && (
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-medium">
                        Cost Price
                      </label>

                      <input
                        type="text"
                        value={formatMoney(
                          itemForm.costPrice
                        )}
                        disabled
                        className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100"
                      />
                    </div>
                  )}

                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">
                      Quantity
                    </label>

                    <input
                      type="number"
                      min="1"
                      value={
                        itemForm.quantity
                      }
                      onChange={(e) =>
                        setItemForm({
                          ...itemForm,
                          quantity:
                            e.target.value,
                        })
                      }
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 focus:ring-2 focus:ring-brand focus:outline-none"
                    />
                  </div>

                  <div className="flex justify-between pt-4">
                    <button
                      onClick={
                        handleAddToBill
                      }
                      disabled={addingToBill}
                      className="bg-brand-green text-white px-4 py-2 rounded-lg shadow hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {addingToBill ? 'Adding…' : 'Add to Bill'}
                    </button>

                    <button
                      onClick={
                        handlePreview
                      }
                      disabled={
                        Object.keys(
                          billingItems
                        ).length === 0
                      }
                      className="bg-brand text-white px-4 py-2 rounded-lg shadow hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Preview
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="@min-[768px]:overflow-y-auto bg-white rounded-lg shadow p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-medium text-lg text-brand">
                    Bill Summary
                  </h3>

                  <h3>
                    <b className="text-brand-green">
                      Cashier:
                    </b>{' '}

                    <span className="font-semibold text-lg text-brand">
                      {username}
                    </span>
                  </h3>
                </div>

                <div className="max-w-md mx-auto bg-white border rounded-lg p-4 font-mono shadow text-sm space-y-2">
                  <h2 className="text-center font-bold text-lg border-b pb-2">
                    Receipt
                  </h2>

                  <div className="font-semibold">
                    Bill ID: {billId}
                  </div>

                  <div className="divide-y">
                    {Object.entries(
                      billingItems
                    ).map(([key, item]) => {
                      const lineTotal =
                        roundMoney(
                          item.unitPrice *
                          item.quantity
                        );

                      return (
                        <div
                          key={key}
                          className="cursor-pointer hover:bg-red-50 py-2"
                          onClick={() =>
                            removeItem(key)
                          }
                          title="Click to remove"
                        >
                          <div className="flex justify-between">
                            <span>
                              #{key}{' '}
                              {item.productCode}{' '}
                              {item.itemName}
                            </span>

                            <span>
                              {formatMoney(
                                lineTotal
                              )}
                            </span>
                          </div>

                          <div className="flex justify-between text-gray-600 text-xs">
                            <span>
                              Retail:{' '}
                              {formatMoney(
                                item.retailPrice
                              )}
                            </span>

                            <span>
                              Rate:{' '}
                              {formatMoney(
                                item.unitPrice
                              )}
                            </span>

                            <span>
                              Qty:{' '}
                              {item.quantity}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex justify-between font-bold text-base border-t pt-2 mt-2">
                    <span>Grand Total</span>

                    <span>
                      {formatMoney(
                        grandTotal
                      )}
                    </span>
                  </div>

                  {customerDirectory[
                    customer
                  ]?.creditBalance > 0 && (
                      <div className="flex justify-between text-xs text-green-700 mt-1">
                        <span>
                          Store credit available
                        </span>

                        <span>
                          {formatMoney(
                            customerDirectory[
                              customer
                            ].creditBalance
                          )}{' '}
                          (auto-applied at checkout)
                        </span>
                      </div>
                    )}

                  <div className="flex justify-between text-sm mt-1 items-center">
                    <span>Paid</span>

                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={paid}
                      onChange={(e) =>
                        setPaid(
                          e.target.value
                        )
                      }
                      className="border px-2 w-24 text-right rounded"
                    />
                  </div>

                  <div className="flex justify-between text-sm mt-1 items-center">
                    <span>Method</span>

                    <select
                      value={
                        paymentMethod
                      }
                      onChange={(e) =>
                        setPaymentMethod(
                          e.target.value
                        )
                      }
                      className="border px-2 py-1 rounded text-sm"
                    >
                      <option value="cash">
                        Cash
                      </option>

                      <option value="card">
                        Card
                      </option>

                      <option value="other">
                        Other
                      </option>
                    </select>
                  </div>

                  <div
                    className={`flex justify-between text-sm font-semibold mt-1 ${balance < 0
                      ? 'text-red-600'
                      : 'text-green-600'
                      }`}
                  >
                    <span>
                      {balance < 0
                        ? 'Balance Due (Credit)'
                        : 'Change'}
                    </span>

                    <span>
                      {formatMoney(
                        Math.abs(balance)
                      )}
                    </span>
                  </div>

                  {customer !== 'unknown' &&
                    customerDirectory[
                    customer
                    ] && (
                      <div
                        className={`flex justify-between text-sm font-semibold mt-1 pt-2 border-t ${roundMoney(
                          (customerDirectory[
                            customer
                          ].totalBalanceDue ||
                            0) -
                          (customerDirectory[
                            customer
                          ].creditBalance ||
                            0)
                        ) > 0
                          ? 'text-red-600'
                          : roundMoney(
                            (customerDirectory[
                              customer
                            ].totalBalanceDue ||
                              0) -
                            (customerDirectory[
                              customer
                            ].creditBalance ||
                              0)
                          ) < 0
                            ? 'text-green-700'
                            : 'text-gray-600'
                          }`}
                      >
                        <span>
                          Customer Balance
                        </span>

                        <span>
                          {formatMoney(
                            roundMoney(
                              (customerDirectory[
                                customer
                              ].totalBalanceDue ||
                                0) -
                              (customerDirectory[
                                customer
                              ].creditBalance ||
                                0)
                            )
                          )}
                        </span>
                      </div>
                    )}
                </div>

                <button
                  onClick={
                    handleGenerateBill
                  }
                  disabled={generatingBill}
                  className="w-full py-2 bg-brand text-white rounded-lg shadow hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {generatingBill ? 'Generating…' : 'Generate Bill'}
                </button>

                <div className="flex space-x-2">
                  <button
                    onClick={() =>
                      setView('add')
                    }
                    className="w-1/2 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-brand hover:text-white"
                  >
                    Add More
                  </button>

                  <button
                    onClick={handleCancel}
                    className="w-1/2 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-brand-green hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {showCustomerForm && (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-xl w-80">
              <h2 className="text-2xl font-bold mb-4 text-center">
                Add Customer
              </h2>

              <form
                onSubmit={
                  handleAddNewCustomer
                }
                className="space-y-2"
              >
                <div>
                  <label className="block text-gray-700 font-medium mb-1">
                    Name
                  </label>

                  <input
                    type="text"
                    value={
                      customerForm.customerName
                    }
                    onChange={(e) =>
                      setCustomerForm({
                        ...customerForm,
                        customerName:
                          e.target.value,
                      })
                    }
                    placeholder="Customer Name"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>

                <div>
                  <label className="block text-gray-700 font-medium mb-1">
                    Mobile
                  </label>

                  <input
                    type="tel"
                    value={
                      customerForm.mobileNo
                    }
                    onChange={(e) =>
                      setCustomerForm({
                        ...customerForm,
                        mobileNo:
                          e.target.value,
                      })
                    }
                    placeholder="Primary Mobile"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>

                <div>
                  <label className="block text-gray-700 font-medium mb-1">
                    Second No
                  </label>

                  <input
                    type="tel"
                    value={
                      customerForm.emergencyMobile
                    }
                    onChange={(e) =>
                      setCustomerForm({
                        ...customerForm,
                        emergencyMobile:
                          e.target.value,
                      })
                    }
                    placeholder="Secondary Mobile"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>

                <div>
                  <label className="block text-gray-700 font-medium mb-1">
                    Email
                  </label>

                  <input
                    type="email"
                    value={
                      customerForm.email
                    }
                    onChange={(e) =>
                      setCustomerForm({
                        ...customerForm,
                        email:
                          e.target.value,
                      })
                    }
                    placeholder="Email Address"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>

                <div>
                  <label className="block text-gray-700 font-medium mb-1">
                    Address
                  </label>

                  <textarea
                    value={
                      customerForm.address
                    }
                    onChange={(e) =>
                      setCustomerForm({
                        ...customerForm,
                        address:
                          e.target.value,
                      })
                    }
                    placeholder="Customer Address"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>

                <div className="text-center pt-2 flex gap-2 justify-center">
                  <button
                    type="submit"
                    className="bg-brand text-white px-6 py-1.5 rounded hover:bg-brand-dark transition"
                  >
                    Add Customer
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setShowCustomerForm(
                        false
                      );
                      setCustomerForm(
                        emptyCustomerForm
                      );
                    }}
                    className="bg-gray-200 text-gray-700 px-4 py-1.5 rounded hover:bg-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}