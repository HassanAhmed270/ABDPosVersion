// Stage 18 — direct thermal (ESC/POS) receipt printing over Web USB, with
// a manual-print fallback owned by the caller (see Billing.jsx's
// printReceiptFor). Nothing in here ever throws to the caller — every
// path that isn't a confirmed successful print resolves `false` so the
// caller can fall back to the existing popup print flow unchanged.
//
// Pairing is a one-time browser permission grant (navigator.usb.requestDevice,
// needs a real click — see pairThermalPrinter, wired to a "Connect
// Thermal Printer" button). Printing itself only ever calls the silent
// navigator.usb.getDevices(), never requestDevice, so a normal sale never
// shows a permission prompt.

const PRINTER_USB_CLASS = 0x07; // USB Printer class

export function isWebUSBSupported() {
  return typeof navigator !== 'undefined' && !!navigator.usb;
}

// Triggers the browser's own device-picker. Must be called from a direct
// user gesture (e.g. a button onClick), not from inside an async chain —
// Web USB requires transient user activation for requestDevice.
export async function pairThermalPrinter() {
  if (!isWebUSBSupported()) return null;
  try {
    return await navigator.usb.requestDevice({ filters: [{ classCode: PRINTER_USB_CLASS }, {}] });
  } catch {
    return null; // user cancelled the picker, or nothing matched
  }
}

// Silent — only returns a device the user already granted via
// pairThermalPrinter in a previous session/click. Never prompts.
export async function getPairedPrinter() {
  if (!isWebUSBSupported()) return null;
  try {
    const devices = await navigator.usb.getDevices();
    return devices[0] || null; // single-shop desktop: one printer assumed
  } catch {
    return null;
  }
}

function findPrinterEndpoint(device) {
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        const out = alt.endpoints.find((e) => e.direction === 'out');
        if (out && (alt.interfaceClass === PRINTER_USB_CLASS || !device.configuration)) {
          return { configValue: config.configurationValue, interfaceNumber: iface.interfaceNumber, endpointNumber: out.endpointNumber };
        }
      }
    }
  }
  // Fallback: first OUT endpoint found on any interface, for printers
  // that don't report the standard printer class correctly.
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        const out = alt.endpoints.find((e) => e.direction === 'out');
        if (out) return { configValue: config.configurationValue, interfaceNumber: iface.interfaceNumber, endpointNumber: out.endpointNumber };
      }
    }
  }
  return null;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const ESC = 0x1b;
const GS = 0x1d;
const LINE_WIDTH = 32; // standard 58mm/80mm thermal roll, monospace font A

function padLine(left, right) {
  const gap = Math.max(1, LINE_WIDTH - left.length - right.length);
  return left + ' '.repeat(gap) + right;
}

// Builds raw ESC/POS bytes for a receipt. `data` mirrors what
// printReceiptFor already assembles for the HTML popup — kept as plain
// fields rather than reusing the HTML string, since a thermal printer
// can't render HTML/CSS at all.
function buildEscPosReceipt(data) {
  const enc = new TextEncoder();
  const chunks = [];
  const line = (text = '') => chunks.push(enc.encode(text + '\n'));

  chunks.push(new Uint8Array([ESC, 0x40])); // initialize
  chunks.push(new Uint8Array([ESC, 0x61, 0x01])); // center align
  chunks.push(new Uint8Array([ESC, 0x21, 0x10])); // double-height
  line('RECEIPT');
  chunks.push(new Uint8Array([ESC, 0x21, 0x00])); // normal size
  chunks.push(new Uint8Array([ESC, 0x61, 0x00])); // left align
  line(`Bill ID: ${data.billId}`);
  if (data.offline) line('OFFLINE - PENDING SYNC');
  line('-'.repeat(LINE_WIDTH));

  for (const item of data.items) {
    line(`${item.itemName}`);
    line(padLine(`  ${item.quantity} x ${item.unitPriceLabel}`, item.netLabel));
  }

  line('-'.repeat(LINE_WIDTH));
  if (data.discountLabel) line(padLine('Discount', `-${data.discountLabel}`));
  line(padLine('Grand Total', data.totalLabel));
  line(padLine('Paid', data.paidLabel));
  line(padLine(data.settlementLabel, data.settlementAmountLabel));
  line('-'.repeat(LINE_WIDTH));
  line(`Customer: ${data.customer}`);
  chunks.push(new Uint8Array([0x0a, 0x0a, 0x0a, 0x0a]));
  chunks.push(new Uint8Array([GS, 0x56, 0x42, 0x00])); // partial cut

  return concatBytes(chunks);
}

// Attempts a direct print to an already-paired thermal printer.
// Resolves `true` only on a confirmed successful write; resolves
// `false` (never throws/rejects) for every other case — no printer
// paired, open/claim failure, write failure — so the caller can fall
// back to the manual popup print unconditionally.
export async function tryThermalPrint(data) {
  let device;
  try {
    device = await getPairedPrinter();
    if (!device) return false;

    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(device.configurations[0]?.configurationValue || 1);
    }
    const endpoint = findPrinterEndpoint(device);
    if (!endpoint) {
      await device.close();
      return false;
    }

    await device.claimInterface(endpoint.interfaceNumber);
    const bytes = buildEscPosReceipt(data);
    const result = await device.transferOut(endpoint.endpointNumber, bytes);
    await device.releaseInterface(endpoint.interfaceNumber);
    await device.close();
    return result.status === 'ok';
  } catch (err) {
    console.error('Thermal print failed, falling back to manual print:', err.message);
    try {
      if (device && device.opened) await device.close();
    } catch {
      // already closed/unplugged — nothing further to clean up
    }
    return false;
  }
}
