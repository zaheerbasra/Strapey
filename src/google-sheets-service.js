/**
 * Uploads purchased shipping label PDFs to Google Drive and appends the
 * matching order row to the ebay_sales_strapey Google Sheet.
 *
 * Requires a GCP service account (GOOGLE_SERVICE_ACCOUNT_PATH) that has been
 * shared as Editor on both the target Sheet (GOOGLE_SHEET_ID) and Drive
 * folder (GOOGLE_DRIVE_LABELS_FOLDER_ID) - see .env.example.
 */

const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');

const SHEET_COLUMNS = [
  'orderId', 'date', 'buyerId', 'buyerName', 'sku', 'qty',
  'salePrice', 'orderEarnings', 'ebayCharges', 'shipping', 'adFee',
  'cost', 'profit', 'shippingLabel',
];

let authClientPromise = null;

function isConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_PATH && process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_DRIVE_LABELS_FOLDER_ID);
}

function getAuthClient() {
  if (!authClientPromise) {
    const keyFile = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
    if (!fs.existsSync(keyFile)) {
      throw new Error(`Google service account key not found at ${keyFile}. See .env.example for setup steps.`);
    }
    authClientPromise = new google.auth.GoogleAuth({
      keyFile,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ],
    }).getClient();
  }
  return authClientPromise;
}

async function uploadLabelToDrive(orderId, pdfPath) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: {
      name: `ebay-label-${orderId}.pdf`,
      parents: [process.env.GOOGLE_DRIVE_LABELS_FOLDER_ID],
    },
    media: {
      mimeType: 'application/pdf',
      body: fs.createReadStream(pdfPath),
    },
    fields: 'id, webViewLink',
  });

  return { fileId: res.data.id, webViewLink: res.data.webViewLink };
}

/**
 * Resolves the numeric sheetId + title for the target tab. If GOOGLE_SHEET_GID
 * is set, matches that specific tab (the sheet may have multiple tabs, e.g.
 * one per month); otherwise falls back to the first tab.
 */
async function getTargetSheet(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const allSheets = meta.data.sheets;
  const gid = process.env.GOOGLE_SHEET_GID;
  const match = gid
    ? allSheets.find((s) => String(s.properties.sheetId) === String(gid))
    : allSheets[0];
  if (!match) {
    throw new Error(`No tab found with gid ${gid} in spreadsheet ${spreadsheetId}`);
  }
  return { sheetId: match.properties.sheetId, title: match.properties.title };
}

/**
 * rowData: { orderId, date, buyerId, buyerName, sku, qty, salePrice,
 *   orderEarnings, ebayCharges, shipping, adFee, labelDriveLink }
 * Cost/Profit are intentionally left blank for manual entry.
 *
 * Inserts the new row directly below the header (row 2), pushing existing
 * rows down, so the most recent order always appears first.
 */
async function insertOrderRowAtTop(rowData, labelDriveLink) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const { sheetId, title } = await getTargetSheet(sheets, spreadsheetId);

  const values = SHEET_COLUMNS.map((col) => {
    if (col === 'cost' || col === 'profit') return '';
    if (col === 'shippingLabel') {
      return labelDriveLink ? `=HYPERLINK("${labelDriveLink}", "ebay-label-${rowData.orderId}")` : '';
    }
    const value = rowData[col];
    return value === undefined || value === null ? '' : value;
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
          inheritFromBefore: false
        }
      }]
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A2:N2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

module.exports = {
  isConfigured,
  uploadLabelToDrive,
  insertOrderRowAtTop,
};
