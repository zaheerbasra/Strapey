/**
 * One-time interactive setup: authenticate a persistent Chrome profile against
 * the seller's real eBay account (including 2FA) so later automated, headless
 * runs (see src/ebay-shipping-label-service.js) can reuse the saved session.
 *
 * Run with: npm run ebay:login-setup
 * Re-run whenever eBay forces a fresh login/verification challenge.
 */

const path = require('path');
const fs = require('fs-extra');
const puppeteer = require('puppeteer');
const readline = require('readline');

const PROFILE_DIR = path.join(__dirname, '..', '..', 'data', '.ebay-seller-profile');

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
  return systemPaths.find(p => fs.existsSync(p)) || null;
}

function waitForEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(promptText, () => { rl.close(); resolve(); }));
}

async function main() {
  fs.ensureDirSync(PROFILE_DIR);

  const executablePath = resolveExecutablePath();
  const launchOptions = {
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  console.log('[ebay-seller-login-setup] Launching browser with profile:', PROFILE_DIR);
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.goto('https://signin.ebay.com/', { waitUntil: 'networkidle2' });

  console.log('\nA Chrome window has opened.');
  console.log('1. Log into your eBay seller account, completing 2FA if prompted.');
  console.log('2. Once you land on eBay signed in (e.g. Seller Hub or My eBay), come back here.');
  await waitForEnter('Press Enter once you are fully logged in... ');

  // Sanity check: navigate to Seller Hub and confirm we're not bounced back to sign-in
  await page.goto('https://www.ebay.com/sh/ovw', { waitUntil: 'networkidle2' });
  const url = page.url();
  if (/signin\.ebay\.com/i.test(url)) {
    console.error('\n[ebay-seller-login-setup] Still on the sign-in page - login was not completed. Re-run this script and try again.');
    await browser.close();
    process.exit(1);
  }

  console.log('\n[ebay-seller-login-setup] Session saved to', PROFILE_DIR);
  console.log('Automated label purchases can now run headless until eBay forces re-authentication.');
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[ebay-seller-login-setup] Failed:', err);
  process.exit(1);
});
