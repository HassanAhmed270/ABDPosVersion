import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import Sidebar from '../components/Sidebar';
import { useAuth } from '../lib/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { api } from '../lib/api';
import { roundMoney, formatMoney, formatMoneyShort } from '../lib/money';
import { printReceipt, buildReceiptHtml } from '../lib/print';
import { SHOP_NAME, SHOP_ADDRESS, SHOP_PHONE } from '../lib/shopInfo';
import { isWebUSBSupported, getPairedPrinter, pairThermalPrinter, tryThermalPrint } from '../lib/thermalPrint';
import { isOfflineSyncEnabled, enqueueSale, saveLocalDraft, getLocalDraft, clearLocalDraft } from '../lib/offlineQueue';
import { isNetworkError, flushQueue } from '../lib/offlineSync';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emptyCustomerForm = { customerName: '', mobileNo: '', emergencyMobile: '', email: '', address: '' };
// Walk-in sentinel: customerName for an untracked walk-in sale — must
// match WALKIN_CUSTOMER in main.js exactly, since this string is sent
// straight through as the order's customerName (same as any real
// customer's name is today) and the backend special-cases this one value
// to skip the Customer lookup/record entirely.
const WALKIN_CUSTOMER = 'Walk-in / Unknown';


export default function Billing() {
  const { username, isAdmin } = useAuth();
  const confirm = useConfirm();

  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  // Per-customer lookup (mobile/address/email/credit/balance) alongside
  // the plain name list used by the dropdown — backs the Customer
  // Balance line below. Keyed by customerName.
  const [customerDirectory, setCustomerDirectory] = useState({});
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState(null);

  const [customer, setCustomer] = useState('unknown');
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [customerForm, setCustomerForm] = useState(emptyCustomerForm);

  const [itemForm, setItemForm] = useState({ productId: '', productName: '', unitPrice: '', costPrice: '', quantity: '', discount: '', discountType: 'none' });
  const [showDiscount, setShowDiscount] = useState(false);
  const [billingItems, setBillingItems] = useState({}); // { itemNo: {...} }
  const [itemNo, setItemNo] = useState(0);

  const [view, setView] = useState('add'); // 'add' | 'preview'
  const [billId, setBillId] = useState(null);
  const [paid, setPaid] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');

  // Stage 11 — offline sync. `isOnline` mirrors the browser's own signal;
  // it's the fast/local half of "are we connected" (an actual failed
  // request is still the real source of truth — see handleAddToBill/
  // handleGenerateBill below, which fall back on a genuine network error
  // even if isOnline was stale). Only ever consulted when the module is
  // enabled (VITE_ENABLE_OFFLINE_SYNC=true) — otherwise Billing behaves
  // exactly as it did before Stage 11.
  const offlineSyncEnabled = isOfflineSyncEnabled();
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    if (!offlineSyncEnabled) return;
    const goOnline = () => {
      setIsOnline(true);
      flushQueue(); // don't wait for the next 15s tick — try immediately on reconnect
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [offlineSyncEnabled]);

  // Stage 18: reflects whether a thermal printer has already been paired
  // in this browser (navigator.usb.getDevices() — silent, no prompt).
  // Purely informational for the "Connect Thermal Printer" button; the
  // actual print attempt in printReceiptFor re-checks this itself.
  const [printerConnected, setPrinterConnected] = useState(false);
  const webUSBSupported = isWebUSBSupported();

  useEffect(() => {
    if (!webUSBSupported) return;
    getPairedPrinter().then((device) => setPrinterConnected(!!device));
    const onChange = () => getPairedPrinter().then((device) => setPrinterConnected(!!device));
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
      toast.success(`Thermal printer paired: ${device.productName || 'USB printer'}`);
    } else {
      toast.error('No printer selected. Bills will use the manual print dialog.');
    }
  };

  // Stage 19: prompts the cashier, via a toast with two explicit choices,
  // what to do with an overpayment before the sale commits. Resolves
  // 'balance' or 'change' — never rejects, and always resolves 'change'
  // if the cashier dismisses it without picking, since that's today's
  // existing behavior and the safer default.
  const chooseOverpaymentSettlement = (amount) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (choice) => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      toast(`Customer overpaid by ${formatMoney(amount)}. What should happen with the extra?`, {
        duration: Infinity,
        action: { label: 'Add to Balance', onClick: () => settle('balance') },
        cancel: { label: 'Give Change', onClick: () => settle('change') },
        onDismiss: () => settle('change'),
        onAutoClose: () => settle('change'),
      });
    });

  const loadProducts = () =>
    api
      .getProducts({ limit: 1000 })
      .then((p) => setProducts(p.products || []))
      .catch((err) => setError(err.message || 'Failed to load products'));

  // Force-save the draft right now, bypassing the debounce below. Used at
  // the two points where the server absolutely needs to be caught up
  // before the next thing happens: right after a bill ID is reserved
  // (Preview) and right before discarding (Cancel). Everywhere else, the
  // debounced autosave is enough — see CLAUDE.md Stage 4.
  //
  // Stage 19: `overpaymentChoiceOverride` carries the cashier's
  // change-vs-balance pick from handleGenerateBill's prompt into the
  // draft, same tamper-resistance reason as paidInput/paymentMethod —
  // the server reads it from the draft at commit time, not from a
  // separate request param. Every other caller (autosave, Preview,
  // Cancel) doesn't know or care about it yet, so it defaults to
  // 'change', matching today's behavior until the cashier is actually
  // asked.
  const saveDraftNow = async (itemsOverride, custOverride, billIdOverride, overpaymentChoiceOverride) => {
    const source = itemsOverride ?? billingItems;
    const itemsArr = Object.values(source).map((it) => ({
      productID: `#${it.productCode}`,
      productName: it.itemName,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      discount: it.discount,
      discountType: it.discountType || 'manual',   // ← add this line
    }));
    try {
      await api.saveDraft({
        billID: billIdOverride !== undefined ? billIdOverride : billId,
        customerName: custOverride !== undefined ? custOverride : customer,
        items: itemsArr,
        // Carried in the draft, same as everything else committed from it
        // (Stage 5) — the server reads this at commit time instead of
        // trusting a value sent only with the commit request.
        paidInput: parseFloat(paid) || 0,
        paymentMethod,
        overpaymentChoice: overpaymentChoiceOverride || 'change',
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
              Object.fromEntries(rows.map((row) => [row.customerName, {
                mobileNo: row.mobileNo || '',
                email: row.email || '',
                address: row.address || '',
                // Stage 5 — store credit auto-applies at checkout; shown
                // here so the cashier isn't surprised by the total.
                creditBalance: row.creditBalance || 0,
                totalBalanceDue: row.totalBalanceDue || 0,
              }]))
            );
          }),
        ]);
      } catch (err) {
        setError(err.message || 'Failed to load billing data');
      }

      // Stage 12 — a draft persisted purely on this device (survives a
      // reload even while offline, when the server-side draft below can't
      // be reached at all). Checked first: if one exists, it's the most
      // recent state of the cart the person was building, regardless of
      // whether it ever made it to the server.
      try {
        const local = await getLocalDraft();
        if (local && Object.keys(local.billingItems || {}).length > 0) {
          const resume = await confirm(`You have an unfinished bill with ${Object.keys(local.billingItems).length} item(s) from earlier. Resume it?`);
          if (resume) {
            setBillingItems(local.billingItems);
            setItemNo(Math.max(0, ...Object.keys(local.billingItems).map(Number)));
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
        console.error('Failed to check for a local draft bill:', err.message);
      }

      // Offer to resume an unfinished bill from a previous session/crash.
      // The stock for these items is already reserved server-side (it was
      // held when they were originally added) — resuming just rehydrates
      // local state to match, it doesn't reserve anything new.
      try {
        const data = await api.getDraft();
        if (data.draft && data.draft.items?.length > 0) {
          const resume = await confirm(`You have an unfinished bill with ${data.draft.items.length} item(s) from earlier. Resume it?`);
          if (resume) {
            const restored = {};
            data.draft.items.forEach((it, idx) => {
              restored[idx + 1] = {
                productCode: it.productID.replace('#', ''),
                itemName: it.productName,
                unitPrice: it.unitPrice,
                quantity: it.quantity,
                discount: it.discount,
                discountType: it.discountType || 'manual',   // ← add this line
              };
            });
            setBillingItems(restored);
            setItemNo(data.draft.items.length);
            setCustomer(data.draft.customerName || 'unknown');
            setBillId(data.draft.billID || null);
            setPaid(data.draft.paidInput ? String(data.draft.paidInput) : '');
            setPaymentMethod(data.draft.paymentMethod || 'cash');
          } else {
            await api.discardDraft();
            await loadProducts(); // released stock changed availability — resync
          }
        }
      } catch (err) {
        console.error('Failed to check for a draft bill:', err.message);
      }
    })();
  }, [confirm]);

  // Debounced autosave: fires ~7s after the cart, customer, or bill ID last
  // changed (spec range was 5-10s). Skips while the cart is empty so we
  // don't overwrite a not-yet-resumed draft with nothing before the person
  // has answered the resume prompt above.
  const draftSaveTimeout = useRef(null);
  useEffect(() => {
    if (Object.keys(billingItems).length === 0) return;
    if (draftSaveTimeout.current) clearTimeout(draftSaveTimeout.current);
    draftSaveTimeout.current = setTimeout(() => {
      saveDraftNow();
    }, 7000);
    return () => clearTimeout(draftSaveTimeout.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingItems, customer, billId, paid, paymentMethod]);

  // Stage 12 — local draft persistence, on every meaningful change, not
  // debounced. This is what actually survives a reload mid-edit while
  // offline (the server autosave above just silently fails offline).
  // Stays local until "Generate Bill" is pressed — no handoff to the
  // server-side PendingBill flow just because connectivity returns.
  useEffect(() => {
    if (Object.keys(billingItems).length === 0) return;
    saveLocalDraft({ billingItems, customer, billId, paid, paymentMethod })
      .catch((err) => console.error('Local draft save failed:', err.message));
  }, [billingItems, customer, billId, paid, paymentMethod]);

  // Best-effort release of any still-held reservations when the person
  // navigates away without checking out — a real tab close/reload (which
  // React's own unmount cleanup can't reliably catch) is handled via
  // `beforeunload` + `fetch(..., { keepalive: true })` below. This is a
  // safety net, not a guarantee: if neither event fires (e.g. the OS kills
  // the browser), the reservation stays held until someone manually
  // corrects it — there's no server-side expiry in this stage. See
  // CLAUDE.md Stage 3 "still open".
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
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ productId: `#${item.productCode}`, quantity: item.quantity }),
        }).catch(() => { });
      });
    };
    window.addEventListener('beforeunload', releaseAllHeld);
    return () => {
      window.removeEventListener('beforeunload', releaseAllHeld);
      releaseAllHeld(); // leaving the Billing page within the SPA
    };
  }, []);

  const filteredProducts = useMemo(() => {
    if (!search) return products;
    const q = search.toLowerCase();
    return products.filter((p) => p.productName.toLowerCase().startsWith(q));
  }, [products, search]);

  const grandTotal = useMemo(() => {
    const total = Object.values(billingItems).reduce((sum, item) => {
      const subtotal = item.unitPrice * item.quantity;
      const net = subtotal - subtotal * (item.discount / 100);
      return sum + net;
    }, 0);
    return roundMoney(total);
  }, [billingItems]);

  const totalDiscount = useMemo(() => {
    const total = Object.values(billingItems).reduce((sum, item) => {
      const subtotal = item.unitPrice * item.quantity;
      return sum + subtotal * (item.discount / 100);
    }, 0);
    return roundMoney(total);
  }, [billingItems]);

  const balance = useMemo(() => {
    const paidNum = parseFloat(paid) || 0;
    return roundMoney(paidNum - grandTotal);
  }, [paid, grandTotal]);

  const handleSelectProduct = (p) => {
    setSelectedProductId(p.productID);
    setItemForm({
      productId: p.productID,
      productName: p.productName,
      unitPrice: p.price ?? 0,
      costPrice: p.costPrice ?? 0,
      quantity: '',
      discount: '',
      discountType: 'none',   // ← add this line
    });
    setShowDiscount(false);   // ← add this line
  };

  const handleAddToBill = async () => {
    if (!selectedProductId) {
      toast.error('Please select a product from the table first!');
      return;
    }
    const quantity = parseInt(itemForm.quantity);
    const discount = parseFloat(itemForm.discount) || 0;
    const unitPrice = roundMoney(itemForm.unitPrice);

    if (!itemForm.productName || isNaN(unitPrice) || isNaN(quantity) || quantity <= 0) {
      toast.error('Please enter valid item details!');
      return;
    }
    if (discount < 0 || discount > 100) {
      toast.error('Discount must be between 0 and 100.');
      return;
    }

    const product = products.find((p) => p.productID === selectedProductId);
    if (!product) {
      toast.error('Invalid product selection!');
      return;
    }

    // Server-side atomic reserve — this is the actual stock guard. The
    // client-side `available` check above is just for a snappy error
    // message; if two cashiers race for the last unit, this call is what
    // decides who actually gets it (see CLAUDE.md Stage 3).
    let reserved;
    try {
      reserved = await api.reserveStock(selectedProductId, quantity);
    } catch (err) {
      // Stage 11: a genuine network failure (not "stock unavailable" —
      // that's a normal rejected response, not a thrown network error)
      // while the module is enabled means we can't reserve, but the sale
      // can still be captured provisionally and re-validated at sync
      // time (see lib/offlineSync.js, routes/sync.js). Anything else
      // (insufficient stock, invalid product) behaves exactly as before.
      if (offlineSyncEnabled && isNetworkError(err)) {
        const alreadyInCart = Object.values(billingItems)
          .filter((it) => it.productCode === selectedProductId.replace('#', ''))
          .reduce((sum, it) => sum + it.quantity, 0);
        const softAvailable = (product.available ?? product.quantity - (product.reserved || 0)) - alreadyInCart;
        if (softAvailable < quantity) {
          toast.error(`Offline — based on the last known stock, only ${Math.max(softAvailable, 0)} unit(s) of this item look available. Add fewer, or confirm with the customer.`);
          return;
        }
        const nextItemNo = itemNo + 1;
        setItemNo(nextItemNo);
        setBillingItems((prev) => ({
          ...prev,
          [nextItemNo]: {
            productCode: selectedProductId.replace('#', ''),
            itemName: itemForm.productName,
            unitPrice,
            quantity,
            discount: roundMoney(discount),
            discountType: discount > 0 ? itemForm.discountType : 'none',
            offline: true, // never reserved server-side — re-validated at sync time
          },
        }));
        setItemForm({ productId: '', productName: '', unitPrice: '', costPrice: '', quantity: '', discount: '', discountType: 'none' });
        setShowDiscount(false);
        setSelectedProductId(null);
        return;
      }
      toast.error(err.message || 'Could not reserve stock for this item.');
      await loadProducts(); // someone else's sale likely just changed availability — resync
      return;
    }

    setProducts((prev) =>
      prev.map((p) =>
        p.productID === selectedProductId
          ? { ...p, quantity: reserved.quantity, reserved: reserved.reserved, available: reserved.available, lowStock: reserved.available <= (p.lowStockThreshold ?? 10) }
          : p
      )
    );

    const nextItemNo = itemNo + 1;
    setItemNo(nextItemNo);
    setBillingItems((prev) => ({
      ...prev,
      [nextItemNo]: {
        productCode: selectedProductId.replace('#', ''),
        itemName: itemForm.productName,
        unitPrice,
        quantity,
        discount: roundMoney(discount),
        discountType: discount > 0 ? itemForm.discountType : 'none',   // ← add this line
      },
    }));

    setItemForm({ productId: '', productName: '', unitPrice: '', costPrice: '', quantity: '', discount: '', discountType: 'none' }); // ← add discountType here
    setShowDiscount(false);   // ← add this line
    setSelectedProductId(null);
  };

  const handlePreview = async () => {
    if (billId) {
      // Already have one — either from earlier this session, or restored
      // from a resumed draft. Don't burn a second order ID.
      setView('preview');
      return;
    }
    try {
      let candidate = '#' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      // Ask the server for a free order id, same retry loop as the original app.
      // (kept small since this is a low-volume single-shop system)
      for (let i = 0; i < 20; i++) {
        try {
          const data = await api.getUniqueOrderId(candidate);
          if (!data.exists) break;
          const num = (parseInt(candidate.slice(1)) + 1) % 10000;
          candidate = '#' + num.toString().padStart(4, '0');
        } catch (err) {
          // Stage 11: can't ask the server offline — use this candidate
          // as a local placeholder. It's informational only; the real ID
          // gets allocated server-side at sync time (see
          // lib/offlineSync.js's allocateOrderId), so a collision here
          // just means the synced order ends up with a different number.
          if (offlineSyncEnabled && isNetworkError(err)) break;
          throw err;
        }
      }
      setBillId(candidate);
      if (offlineSyncEnabled && !isOnline) {
        // No server draft to persist to while offline — the whole cart
        // stays client-side until Generate Bill queues it (see
        // handleGenerateBill).
        setView('preview');
        return;
      }
      // Persist the reserved ID immediately rather than waiting for the
      // debounce — if the person clicks Generate Bill in the next second,
      // the server needs to already know this bill's ID. (saveDraftNow
      // already swallows its own errors — see its definition above — so
      // a network hiccup here just means the debounced autosave picks it
      // up later instead.)
      await saveDraftNow(undefined, undefined, candidate);
      setView('preview');
    } catch (err) {
      toast.error('Error generating bill id: ' + err.message);
    }
  };

  const removeItem = async (key) => {
    if (!(await confirm('Do you want to remove this item?'))) return;
    const item = billingItems[key];

    // Remove from the cart immediately for responsiveness; the release
    // call runs after, and if it fails we just log it — worst case the
    // reservation lingers until the beforeunload/unmount safety net or a
    // manual admin correction clears it (see CLAUDE.md Stage 3).
    setBillingItems((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      // Offline-added items were never reserved server-side (Stage 11) —
      // nothing to release.
      if (item.offline) {
        return;
      }
      const released = await api.releaseStock(`#${item.productCode}`, item.quantity);
      setProducts((prev) =>
        prev.map((p) =>
          p.productID === `#${item.productCode}`
            ? { ...p, quantity: released.quantity ?? p.quantity, reserved: released.reserved ?? p.reserved, available: released.available ?? p.available }
            : p
        )
      );
    } catch (err) {
      console.error('Failed to release reserved stock:', err.message);
    }
  };

  const resetBill = () => {
    setBillingItems({});
    setItemNo(0);
    setBillId(null);
    setPaid('');
    setPaymentMethod('cash');
    setView('add');
    clearLocalDraft().catch((err) => console.error('Failed to clear local draft:', err.message));
  };

  const handleCancel = async () => {
    // Make sure the server's draft reflects exactly what we're about to
    // discard — anything added in the last few seconds might not have
    // hit the debounced autosave yet.
    await saveDraftNow();
    resetBill();
    try {
      await api.discardDraft(); // releases every reserved item in one call
    } catch (err) {
      console.error('Failed to discard draft:', err.message);
    }
    await loadProducts();
  };

  // Extracted from the original inline receipt-building so both the
  // normal (online) success path and the Stage 11 offline-queued path
  // can share it — `offline` just adds a visible marker so the printed
  // slip is honest about not being a confirmed sale yet.
  //
  // Stage 18: now async — tries a direct thermal (ESC/POS/Web USB) print
  // first via tryThermalPrint(); that call is self-contained and never
  // throws, resolving `false` for "no printer paired" same as any other
  // failure. Only on `false` does it fall through to exactly the same
  // popup-print flow as before this stage.
  //
  // Stage 19: `overpaymentChoice` ('change'|'balance', default 'change')
  // only changes the label shown for an overpayment — 'change' means
  // exactly what it said before this stage; 'balance' is only ever
  // passed when that's genuinely what happened server-side (see
  // handleGenerateBill — the offline-queued call site always passes
  // 'change' explicitly, since offline sync never applies balance).
  const printReceiptFor = async (total, paidNum, offline = false, overpaymentChoice = 'change') => {
    const isOverpaid = paidNum > total;
    const settlementLabel = paidNum < total ? 'Balance Due (Credit)' : isOverpaid && overpaymentChoice === 'balance' ? 'Added to Customer Balance' : 'Change';
    const settlementAmount = formatMoney(Math.abs(paidNum - total));

    if (webUSBSupported) {
      const printed = await tryThermalPrint({
        billId,
        offline,
        items: Object.entries(billingItems).map(([, item]) => {
          const subtotal = item.unitPrice * item.quantity;
          const net = roundMoney(subtotal - subtotal * (item.discount / 100));
          return { itemName: item.itemName, quantity: item.quantity, unitPriceLabel: formatMoney(item.unitPrice), netLabel: formatMoney(net) };
        }),
        discountLabel: totalDiscount > 0 ? formatMoney(totalDiscount) : null,
        totalLabel: formatMoney(total),
        paidLabel: formatMoney(paidNum),
        settlementLabel,
        settlementAmountLabel: settlementAmount,
        customer,
      });
      if (printed) {
        toast.success('Printed to thermal printer.');
        return;
      }
    }

    const items = Object.entries(billingItems).map(([, item]) => {
      const subtotal = roundMoney(item.unitPrice * item.quantity);
      const discountAmount = roundMoney(subtotal * (item.discount / 100));
      const total = roundMoney(subtotal - discountAmount);

      return {
        itemName: item.itemName,
        retailLabel: formatMoneyShort(item.unitPrice),
        qty: item.quantity,
        subtotalLabel: formatMoneyShort(subtotal),
        discountLabel: formatMoneyShort(discountAmount),
        totalLabel: formatMoneyShort(total),
      };
    });
    const html = buildReceiptHtml({
      shopName: SHOP_NAME,
      shopAddress: SHOP_ADDRESS,
      shopPhone: SHOP_PHONE,
      billId,
      offline,
      customerName: customer === WALKIN_CUSTOMER ? 'Walk-in' : customer,
      customerAddress: customerDirectory[customer]?.address || '',
      items,
      discountLabel: totalDiscount > 0 ? formatMoney(totalDiscount) : null,
      grandTotalLabel: formatMoney(total),
      paidLabel: formatMoney(paidNum),
      settlementLabel,
      settlementAmountLabel: settlementAmount,
    });

    printReceipt(html);
  }
  const handleGenerateBill = async () => {
    const total = grandTotal;
    const paidNum = parseFloat(paid) || 0;
    if (paidNum < 0) {
      toast.error('Payment amount can\'t be negative.');
      return;
    }
    if (customer === 'unknown') {
      toast.error('Please select a customer before generating the bill.');
      return;
    }
    // Underpayment is now allowed — the shortfall becomes customer credit
    // (Stage 5) — but it's still worth a confirmation so nobody generates
    // a bill on $0 paid by mistake.
    if (paidNum < total) {
      const shortfall = roundMoney(total - paidNum);
      const proceed = await confirm(
        `Customer is paying ${formatMoney(paidNum)} of ${formatMoney(total)}. ` +
        `${formatMoney(shortfall)} will be recorded as a balance owed on their account. Continue?`
      );
      if (!proceed) return;
    }

    // Stage 19: an overpayment on a real customer's sale needs the
    // cashier to say what happens to the extra. A walk-in sale has no
    // customer account to credit, so it's always change — no prompt.
    // Only asked while apparently online: if offlineSyncEnabled and the
    // network already looks down, the sale is going to queue offline
    // regardless, and offline sync never applies balance (confirmed
    // default), so asking would be misleading.
    let overpaymentChoice = 'change';
    const overpaidAmount = roundMoney(paidNum - total);
    if (overpaidAmount > 0 && customer !== WALKIN_CUSTOMER && (!offlineSyncEnabled || isOnline)) {
      overpaymentChoice = await chooseOverpaymentSettlement(overpaidAmount);
    }

    try {
      // Make sure the server's draft is exactly what's on screen before
      // asking it to commit — it's what the server treats as the source
      // of truth for what's being sold (see CLAUDE.md Stage 4).
      await saveDraftNow(undefined, undefined, undefined, overpaymentChoice);

      // No payload: the server reads the cashier's persisted draft rather
      // than trusting anything sent here. It re-verifies price/discount
      // against the draft (Stage 2/4), commits stock atomically, computes
      // amountPaid/balanceDue/paymentStatus from draft.paidInput (Stage
      // 5), and clears the draft on success (Stage 3/4) — nothing further
      // to send or persist from this side.
      const data = await api.saveOrder();
      if (!data.success) {
        toast.error(data.message || 'Order failed. Try again.');
        return;
      }

      await printReceiptFor(total, paidNum, false, overpaymentChoice);
      toast.success('Order saved successfully.');
      resetBill();
      setCustomer('unknown');
      await loadProducts();
    } catch (err) {
      // Stage 11: a genuine network failure — not a rejected order — is
      // the one case where we don't just show an error. The whole cart
      // gets queued as one offline sale (durable in IndexedDB) instead of
      // lost, and re-validated against live stock/prices when the queue
      // flushes (see lib/offlineSync.js, routes/sync.js). Any other
      // failure (validation, stock conflict while actually online, etc.)
      // behaves exactly as before Stage 11.
      if (offlineSyncEnabled && isNetworkError(err)) {
        try {
          await enqueueSale({
            idempotencyKey: crypto.randomUUID(),
            clientBillID: billId,
            customerName: customer,
            items: Object.values(billingItems).map((it) => ({
              productID: `#${it.productCode}`,
              productName: it.itemName,
              unitPrice: it.unitPrice,
              quantity: it.quantity,
              discount: it.discount,
              discountType: it.discountType || 'manual',
            })),
            paidInput: paidNum,
            paymentMethod,
            createdOfflineAt: new Date().toISOString(),
          });
          // Stage 19: honest receipt — offline sync never applies a
          // balance credit, so this always prints as change regardless
          // of what was chosen above (only reachable if the network
          // looked fine when asked but then failed).
          await printReceiptFor(total, paidNum, true, 'change');
          toast.success('No connection — this bill has been saved on this device and will sync automatically once you\'re back online.');
          resetBill();
          setCustomer('unknown');
        } catch (queueErr) {
          toast.error('Could not save this bill, even offline: ' + queueErr.message);
        }
        return;
      }
      toast.error('Error saving order: ' + err.message);
    }
  };

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
    const { customerName, mobileNo, emergencyMobile, email, address } = customerForm;
    if (!customerName && !mobileNo && !emergencyMobile && !email && !address) {
      setShowCustomerForm(false);
      return;
    }
    if (email && !emailPattern.test(email)) {
      toast.error('Please enter a valid email address.');
      return;
    }
    const cleanName = customerName.trim().replace(/\s+/g, ' ');
    try {
      const data = await api.addCustomer({ customerName: cleanName, mobileNo, emergencyMobile, email, address });
      if (data.success) {
        setCustomers((prev) => [...prev, cleanName]);
        setCustomerDirectory((prev) => ({ ...prev, [cleanName]: { mobileNo, email, address } }));
        setCustomer(cleanName);
        toast.success('New customer added successfully!');
      } else {
        toast.error(data.message || 'Failed to add new customer.');
      }
    } catch (err) {
      toast.error('Error adding customer: ' + err.message);
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
            <h1 className="text-2xl @min-[640px]:text-3xl @min-[768px]:text-4xl font-bold text-brand">Creating Invoice</h1>
            {webUSBSupported && (
              <button
                onClick={handleConnectPrinter}
                className={`text-sm px-3 py-1.5 rounded-lg border ${printerConnected ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                {printerConnected ? '🖨️ Thermal Printer Connected' : '🖨️ Connect Thermal Printer'}
              </button>
            )}
            <select
              value={showCustomerForm ? 'New Customer' : customer}
              onChange={(e) => handleCustomerSelect(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 w-full @min-[640px]:w-52 focus:ring-2 focus:ring-brand focus:outline-none"
            >
              <option value="unknown">Select Customer</option>
              <option value={WALKIN_CUSTOMER}>🚶 Walk-in / Unknown</option>
              {customers.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              <option value="New Customer">+ New customer</option>
            </select>
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          {offlineSyncEnabled && !isOnline && (
            <div className="bg-amber-50 border border-amber-300 text-amber-800 text-sm rounded-lg px-4 py-2">
              You're offline. Bills can still be created — they'll be saved on this device and synced automatically
              once you're back online. Stock and prices will be re-checked at that point.
            </div>
          )}

          <div className="grid grid-cols-1 @min-[768px]:grid-cols-3 gap-6 @min-[768px]:h-[600px]">
            <div className="@min-[768px]:col-span-2 bg-white rounded-lg shadow p-4 @min-[768px]:overflow-y-auto">
              <input
                type="text"
                placeholder="Search Products"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 w-full mb-3 focus:ring-2 focus:ring-brand focus:outline-none"
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm border border-gray-200 rounded-lg overflow-hidden">
                  <thead className="bg-brand text-white">
                    <tr>
                      <th className="text-left p-2">Code</th>
                      <th className="text-left p-2">Name</th>
                      <th className="text-left p-2">In Stock</th>
                      <th className="text-left p-2">Unit Price</th>
                      <th className="text-left p-2">Stock's Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProducts.length === 0 ? (
                      <tr><td colSpan={5} className="p-2 text-center text-gray-500">No products available</td></tr>
                    ) : (
                      filteredProducts.map((p) => {
                        const available = p.available ?? p.quantity - (p.reserved || 0);
                        const lowStock = p.lowStock ?? available <= (p.lowStockThreshold ?? 10);
                        return (
                          <tr
                            key={p.productID}
                            onClick={() => handleSelectProduct(p)}
                            className={`cursor-pointer hover:bg-blue-50 ${selectedProductId === p.productID ? 'bg-blue-100' : ''} ${lowStock ? 'bg-red-50' : ''}`}
                          >
                            <td className="p-2">{p.productID}</td>
                            <td className="p-2">{p.productName}</td>
                            <td className={`p-2 ${lowStock ? 'text-red-700 font-semibold' : ''}`}>
                              {available}
                              {lowStock && <span className="ml-1 text-xs font-normal">⚠ low</span>}
                            </td>
                            <td className="p-2">{formatMoney(p.price ?? 0)}</td>
                            <td className="p-2">{formatMoney((p.price ?? 0) * available)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {view === 'add' ? (
              <div className="@min-[768px]:overflow-y-auto bg-white rounded-lg shadow p-4 space-y-3">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-medium text-lg text-brand">Add Product</h3>
                  {billId && <h3><b className="text-brand-green">Bill ID:</b> <span className="font-semibold text-lg">{billId}</span></h3>}
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Product ID</label>
                    <input type="text" value={itemForm.productId} disabled className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100" />
                  </div>
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Product Name</label>
                    <input type="text" value={itemForm.productName} disabled className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100" />
                  </div>
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Unit Price</label>
                    <input type="number" value={itemForm.unitPrice} disabled className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100" />
                  </div>
                  {isAdmin && (
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-medium">Cost Price</label>
                      <input type="text" value={formatMoney(itemForm.costPrice)} disabled className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100" />
                    </div>
                  )}
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Quantity</label>
                    <input
                      type="number"
                      value={itemForm.quantity}
                      onChange={(e) => setItemForm({ ...itemForm, quantity: e.target.value })}
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  {!showDiscount ? (
                    <button
                      type="button"
                      onClick={() => setShowDiscount(true)}
                      className="text-sm text-brand-green font-medium hover:underline"
                    >
                      + Add Discount
                    </button>
                  ) : (
                    <div className="border border-dashed border-gray-300 rounded-lg p-3 space-y-2">
                      <div className="flex justify-between items-center">
                        <label className="text-sm font-medium">Discount</label>
                        <button
                          type="button"
                          onClick={() => setItemForm({ ...itemForm, discount: '', discountType: 'none' })}
                          className="text-xs text-gray-400 hover:text-red-600"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="flex gap-2">
                        {[10, 15, 20].map((pct) => (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => setItemForm({ ...itemForm, discount: String(pct), discountType: 'preset' })}
                            className={`flex-1 py-1.5 rounded-lg text-sm border ${itemForm.discountType === 'preset' && Number(itemForm.discount) === pct
                              ? 'bg-brand-green text-white border-brand-green'
                              : 'bg-white text-gray-700 border-gray-300 hover:border-brand-green'
                              }`}
                          >
                            {pct}%
                          </button>
                        ))}
                      </div>
                      <div className="flex justify-between items-center">
                        <label className="text-xs text-gray-500">Or manual %</label>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={itemForm.discount}
                          onChange={(e) => setItemForm({ ...itemForm, discount: e.target.value, discountType: 'manual' })}
                          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-2/3 focus:ring-2 focus:ring-brand-green"
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex justify-between pt-4">
                    <button onClick={handleAddToBill} className="bg-brand-green text-white px-4 py-2 rounded-lg shadow hover:bg-green-700">
                      Add to Bill
                    </button>
                    <button
                      onClick={handlePreview}
                      disabled={Object.keys(billingItems).length === 0}
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
                  <h3 className="font-medium text-lg text-brand">Bill Summary</h3>
                  <h3><b className="text-brand-green">Cashier:</b> <span className="font-semibold text-lg text-brand">{username}</span></h3>
                </div>

                <div className="max-w-md mx-auto bg-white border rounded-lg p-4 font-mono shadow text-sm space-y-2">
                  <h2 className="text-center font-bold text-lg border-b pb-2">Receipt</h2>
                  <div className="font-semibold">Bill ID: {billId}</div>
                  <div className="divide-y">
                    {Object.entries(billingItems).map(([key, item]) => {
                      const subtotal = item.unitPrice * item.quantity;
                      const net = roundMoney(subtotal - subtotal * (item.discount / 100));
                      return (
                        <div
                          key={key}
                          className="cursor-pointer hover:bg-red-50 py-1"
                          onClick={() => removeItem(key)}
                          title="Click to remove"
                        >
                          <div className="flex justify-between">
                            <span>#{key} {item.productCode} {item.itemName}</span>
                          </div>
                          <div className="flex justify-between text-gray-600">
                            <span>{item.quantity} × {formatMoney(item.unitPrice)} {item.discount > 0 ? `-${item.discount}%` : ''}</span>
                            <span>= {formatMoney(net)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {totalDiscount > 0 && (
                    <div className="flex justify-between text-xs text-gray-600 mt-1">
                      <span>Discount</span>
                      <span>-{formatMoney(totalDiscount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-base border-t pt-2 mt-2">
                    <span>Grand Total</span>
                    <span>{formatMoney(grandTotal)}</span>
                  </div>
                  {customerDirectory[customer]?.creditBalance > 0 && (
                    <div className="flex justify-between text-xs text-green-700 mt-1">
                      <span>Store credit available</span>
                      <span>{formatMoney(customerDirectory[customer].creditBalance)} (auto-applied at checkout)</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm mt-1 items-center">
                    <span>Paid</span>
                    <input
                      type="number"
                      step="0.01"
                      value={paid}
                      onChange={(e) => setPaid(e.target.value)}
                      className="border px-2 w-24 text-right rounded"
                    />
                  </div>
                  <div className="flex justify-between text-sm mt-1 items-center">
                    <span>Method</span>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="border px-2 py-1 rounded text-sm"
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className={`flex justify-between text-sm font-semibold mt-1 ${balance < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    <span>{balance < 0 ? 'Balance Due (Credit)' : 'Change'}</span>
                    <span>{formatMoney(Math.abs(balance))}</span>
                  </div>
                  {customer !== 'unknown' && customerDirectory[customer] && (
                    (() => {
                      const preSaleBalance = roundMoney(
                        (customerDirectory[customer].totalBalanceDue || 0) - (customerDirectory[customer].creditBalance || 0)
                      );
                      return (
                        <div className={`flex justify-between text-sm font-semibold mt-1 pt-2 border-t ${preSaleBalance > 0 ? 'text-red-600' : preSaleBalance < 0 ? 'text-green-700' : 'text-gray-600'}`}>
                          <span>Customer Balance</span>
                          <span>{formatMoney(preSaleBalance)}{preSaleBalance < 0 ? ' (in credit)' : preSaleBalance > 0 ? ' (owes)' : ''}</span>
                        </div>
                      );
                    })()
                  )}
                </div>

                <button onClick={() => handleGenerateBill()} className="w-full py-2 bg-brand text-white rounded-lg shadow hover:bg-blue-700">
                  Generate Bill
                </button>

                <div className="flex space-x-2">
                  <button onClick={() => setView('add')} className="w-1/2 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-brand hover:text-white">
                    Add More
                  </button>
                  <button onClick={handleCancel} className="w-1/2 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-brand-green hover:text-white">
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
              <h2 className="text-2xl font-bold mb-4 text-center">Add Customer</h2>
              <form onSubmit={handleAddNewCustomer} className="space-y-2">
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Name</label>
                  <input
                    type="text"
                    value={customerForm.customerName}
                    onChange={(e) => setCustomerForm({ ...customerForm, customerName: e.target.value })}
                    placeholder="Customer Name"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Mobile</label>
                  <input
                    type="tel"
                    value={customerForm.mobileNo}
                    onChange={(e) => setCustomerForm({ ...customerForm, mobileNo: e.target.value })}
                    placeholder="Primary Mobile"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Second No</label>
                  <input
                    type="tel"
                    value={customerForm.emergencyMobile}
                    onChange={(e) => setCustomerForm({ ...customerForm, emergencyMobile: e.target.value })}
                    placeholder="Secondary Mobile"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Email</label>
                  <input
                    type="email"
                    value={customerForm.email}
                    onChange={(e) => setCustomerForm({ ...customerForm, email: e.target.value })}
                    placeholder="Email Address"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Address</label>
                  <textarea
                    value={customerForm.address}
                    onChange={(e) => setCustomerForm({ ...customerForm, address: e.target.value })}
                    placeholder="Customer Address"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div className="text-center pt-2 flex gap-2 justify-center">
                  <button type="submit" className="bg-brand text-white px-6 py-1.5 rounded hover:bg-brand-dark transition">
                    Add Customer
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCustomerForm(false); setCustomerForm(emptyCustomerForm); }}
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