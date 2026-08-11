/**
 * Drives eBay Seller Hub's real "Buy shipping label" flow with Puppeteer,
 * using the persistent authenticated profile set up by
 * src/utils/ebay-seller-login-setup.js (npm run ebay:login-setup).
 *
 * There is no public eBay API for this (the Sell Logistics API that could do
 * it is whitelist-restricted), so this mirrors the seller's own manual click
 * path instead. Selectors below are text-based (resilient to class-name
 * churn) but Seller Hub's DOM isn't publicly documented, so a debug screenshot
 * + full-page HTML dump is captured at every step and on any failure, under
 * data/labels/<orderId>/debug/, to make live troubleshooting fast.
 */

const path = require('path');
const fs = require('fs-extra');
const puppeteer = require('puppeteer');

const PROFILE_DIR = path.join(__dirname, '..', 'data', '.ebay-seller-profile');
const LABELS_DIR = path.join(__dirname, '..', 'data', 'labels');

const FIXED_WEIGHT_OZ = 4; // only applied if the weight field is empty/zero
const FIXED_DIMENSIONS = { length: 8, width: 8, height: 1 }; // always applied
const REQUIRED_SERVICE_TEXT = 'USPS Ground Advantage';
const REQUIRED_CUSTOM_MESSAGE = 'Item title or SKU';

class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.errorType = 'session_expired';
  }
}

class AutomationMismatchError extends Error {
  constructor(message) {
    super(message);
    this.errorType = 'automation_mismatch';
  }
}

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  try {
    const bundled = puppeteer.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (e) {
    // fall through to system browser search below
  }
  const systemPaths = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'linux'
      ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      : [];
  return systemPaths.find((p) => fs.existsSync(p)) || null;
}

async function launchBrowser({ headless = true } = {}) {
  const executablePath = resolveExecutablePath();
  const opts = {
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    userDataDir: PROFILE_DIR,
  };
  if (executablePath) opts.executablePath = executablePath;
  return puppeteer.launch(opts);
}

async function debugCapture(page, debugDir, stepName) {
  try {
    fs.ensureDirSync(debugDir);
    await page.screenshot({ path: path.join(debugDir, `${stepName}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(debugDir, `${stepName}.html`), html);
  } catch (e) {
    console.warn('[ShippingLabel] debug capture failed for step', stepName, e.message);
  }
}

function assertNotSignedOut(page) {
  if (/signin\.ebay\.com/i.test(page.url())) {
    throw new SessionExpiredError('eBay session expired or was never authenticated - run `npm run ebay:login-setup` to (re)authenticate, then try again.');
  }
}

/**
 * Finds the table row for this order on the "Awaiting shipment" Seller Hub
 * view and clicks its "Get shipping label" action, then waits for navigation
 * to the label purchase page.
 */
async function openLabelPageForOrder(page, orderId, debugDir) {
  await page.goto('https://www.ebay.com/sh/ord?filter=status:AWAITING_SHIPMENT', {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });
  assertNotSignedOut(page);
  await debugCapture(page, debugDir, '01-awaiting-shipment');

  const rowHandle = await page.evaluateHandle((id) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    return rows.find((tr) => tr.textContent && tr.textContent.includes(id)) || null;
  }, orderId);

  const row = rowHandle.asElement();
  if (!row) {
    throw new AutomationMismatchError(`Could not find order ${orderId} on the Awaiting Shipment page - it may already be shipped, or the order list needs a fresh page load.`);
  }

  const getLabelHandle = await row.evaluateHandle((rowEl) => {
    const candidates = Array.from(rowEl.querySelectorAll('button, a'));
    return candidates.find((el) => /get shipping label/i.test(el.textContent || '')) || null;
  });
  const getLabelButton = getLabelHandle.asElement();
  if (!getLabelButton) {
    throw new AutomationMismatchError(`Found order ${orderId} but no "Get shipping label" button in its row - it may already have a label, or Seller Hub's layout changed.`);
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
    getLabelButton.click(),
  ]);
  assertNotSignedOut(page);
  await debugCapture(page, debugDir, '02-label-page-opened');
}

/** Finds an <input> whose nearby label text matches, within a section between two headings. */
async function fillFieldNearLabel(page, labelText, value) {
  return page.evaluate((label, val) => {
    const all = Array.from(document.querySelectorAll('body *'));
    const labelEl = all.find((el) => el.children.length === 0 && el.textContent.trim() === label);
    if (!labelEl) return false;
    let container = labelEl.closest('div');
    for (let hops = 0; hops < 4 && container; hops += 1) {
      const input = container.querySelector('input');
      if (input) {
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.value = String(val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        return true;
      }
      container = container.parentElement;
    }
    return false;
  }, labelText, value);
}

async function getFieldValueNearLabel(page, labelText) {
  return page.evaluate((label) => {
    const all = Array.from(document.querySelectorAll('body *'));
    const labelEl = all.find((el) => el.children.length === 0 && el.textContent.trim() === label);
    if (!labelEl) return null;
    let container = labelEl.closest('div');
    for (let hops = 0; hops < 4 && container; hops += 1) {
      const input = container.querySelector('input');
      if (input) return input.value;
      container = container.parentElement;
    }
    return null;
  }, labelText);
}

async function setWeightAndDimensions(page, debugDir) {
  const currentLb = await getFieldValueNearLabel(page, 'lb');
  const currentOz = await getFieldValueNearLabel(page, 'oz');
  const weightIsEmpty = (!currentLb || Number(currentLb) === 0) && (!currentOz || Number(currentOz) === 0);
  if (weightIsEmpty) {
    await fillFieldNearLabel(page, 'lb', 0);
    await fillFieldNearLabel(page, 'oz', FIXED_WEIGHT_OZ);
  }

  const dimInputs = await page.$$('input');
  // Dimensions row is 3 adjacent inputs labeled "in" x "in" x "in" - locate via the
  // "Dimensions" heading's containing block rather than guessing global input order.
  const filled = await page.evaluate((dims) => {
    const all = Array.from(document.querySelectorAll('body *'));
    const heading = all.find((el) => el.children.length === 0 && el.textContent.trim() === 'Dimensions');
    if (!heading) return false;
    let container = heading.closest('div');
    for (let hops = 0; hops < 4 && container; hops += 1) {
      const inputs = Array.from(container.querySelectorAll('input'));
      if (inputs.length >= 3) {
        const values = [dims.length, dims.width, dims.height];
        inputs.slice(0, 3).forEach((input, i) => {
          input.focus();
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.value = String(values[i]);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        });
        return true;
      }
      container = container.parentElement;
    }
    return false;
  }, FIXED_DIMENSIONS);

  await debugCapture(page, debugDir, '03-weight-dimensions-set');
  if (!filled) {
    throw new AutomationMismatchError('Could not locate the Dimensions inputs on the label page - Seller Hub layout may have changed.');
  }
  void dimInputs; // kept for future selector refinement if the above heuristic needs adjusting
}

async function selectRequiredService(page, debugDir) {
  const selected = await page.evaluate((requiredText) => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const radio of radios) {
      const container = radio.closest('div, label') || radio.parentElement;
      const text = container ? container.textContent : '';
      if (text && text.includes(requiredText)) {
        radio.click();
        return true;
      }
    }
    return false;
  }, REQUIRED_SERVICE_TEXT);

  await debugCapture(page, debugDir, '04-service-selected');
  if (!selected) {
    throw new AutomationMismatchError(`Could not find/select the "${REQUIRED_SERVICE_TEXT}" shipping service option - refusing to fall back to any other carrier/service.`);
  }
}

async function assertNoPackageProtection(page) {
  const anyChecked = await page.evaluate(() => {
    const labels = ['Additional liability coverage', 'Require signature at delivery'];
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    return checkboxes.some((cb) => {
      const container = cb.closest('div, label') || cb.parentElement;
      const text = container ? container.textContent : '';
      return labels.some((l) => text.includes(l)) && cb.checked;
    });
  });
  if (anyChecked) {
    throw new AutomationMismatchError('A package protection checkbox (liability coverage / signature required) was checked - refusing to purchase with unexpected add-ons.');
  }
}

async function setCustomMessageDropdown(page) {
  await page.evaluate((requiredText) => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const select of selects) {
      const options = Array.from(select.options).map((o) => o.textContent.trim());
      if (options.some((o) => o.includes(requiredText))) {
        const match = Array.from(select.options).find((o) => o.textContent.includes(requiredText));
        if (match) {
          select.value = match.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
    }
  }, REQUIRED_CUSTOM_MESSAGE);
}

async function ensurePrintableLabelFormat(page) {
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, div[role="radio"], label'));
    const printable = candidates.find((el) => /printable label/i.test(el.textContent || ''));
    if (printable) printable.click();
  });
}

async function readQuotedPrice(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('body *'));
    const priceEl = candidates.find((el) => el.children.length === 0 && /^\$\d+\.\d{2}$/.test(el.textContent.trim())
      && el.closest('button, [class*="total" i], [class*="Total" i]'));
    if (priceEl) return priceEl.textContent.trim();
    // Fallback: look for a "Total" label with an adjacent $ amount
    const totalLabel = candidates.find((el) => el.children.length === 0 && el.textContent.trim() === 'Total');
    if (totalLabel && totalLabel.parentElement) {
      const match = totalLabel.parentElement.textContent.match(/\$\d+\.\d{2}/);
      if (match) return match[0];
    }
    return null;
  });
}

async function clickBuyLabelAndDownload(page, downloadDir, debugDir) {
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  const buyClicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button'));
    const buyBtn = candidates.find((el) => /buy shipping label/i.test(el.textContent || ''));
    if (buyBtn) {
      buyBtn.click();
      return true;
    }
    return false;
  });
  await debugCapture(page, debugDir, '05-buy-clicked');
  if (!buyClicked) {
    throw new AutomationMismatchError('Could not find the "Buy shipping label" button.');
  }

  // Wait for a file to land in the download dir
  const deadline = Date.now() + 30000;
  let downloadedFile = null;
  while (Date.now() < deadline && !downloadedFile) {
    await new Promise((r) => setTimeout(r, 1000));
    const files = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : [];
    const finished = files.find((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
    if (finished) downloadedFile = path.join(downloadDir, finished);
  }
  await debugCapture(page, debugDir, '06-after-buy-wait');
  if (!downloadedFile) {
    throw new AutomationMismatchError('Clicked "Buy shipping label" but no PDF was downloaded within 30s - the purchase may have failed or eBay may be showing a confirmation step this automation does not yet handle. Check the debug screenshots before retrying (retrying blindly could double-purchase a label).');
  }
  return downloadedFile;
}

async function purchaseShippingLabel(orderId) {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new SessionExpiredError('No eBay session found. Run `npm run ebay:login-setup` first.');
  }

  const orderLabelDir = path.join(LABELS_DIR, orderId);
  const debugDir = path.join(orderLabelDir, 'debug');
  const downloadDir = path.join(orderLabelDir, '.download-tmp');
  fs.ensureDirSync(orderLabelDir);
  fs.ensureDirSync(downloadDir);

  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    await openLabelPageForOrder(page, orderId, debugDir);
    await setWeightAndDimensions(page, debugDir);
    await selectRequiredService(page, debugDir);
    await assertNoPackageProtection(page);
    await setCustomMessageDropdown(page);
    await ensurePrintableLabelFormat(page);
    const quotedPrice = await readQuotedPrice(page);

    await page.screenshot({ path: path.join(orderLabelDir, 'pre-purchase.png'), fullPage: true });

    const downloadedFile = await clickBuyLabelAndDownload(page, downloadDir, debugDir);
    const finalPdfPath = path.join(orderLabelDir, 'label.pdf');
    fs.moveSync(downloadedFile, finalPdfPath, { overwrite: true });
    fs.removeSync(downloadDir);

    return {
      orderId,
      pdfPath: finalPdfPath,
      screenshotPath: path.join(orderLabelDir, 'pre-purchase.png'),
      price: quotedPrice ? Number(quotedPrice.replace('$', '')) : null,
      purchasedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  purchaseShippingLabel,
  SessionExpiredError,
  AutomationMismatchError,
};
