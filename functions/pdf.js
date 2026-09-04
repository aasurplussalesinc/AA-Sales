/**
 * SkidSling - HTML to PDF.
 *
 * Renders the estimate/invoice through headless Chrome, which is the same
 * engine the Purchase Orders print button uses. That is the whole point: a
 * PDF a customer receives by email is the same document, laid out by the same
 * renderer, as the one that comes out of the print dialog. Drawing it by hand
 * with a PDF library would drift from the UI the first time the template moved.
 *
 * Uses puppeteer-core + @sparticuz/chromium rather than full puppeteer, so the
 * function stays deployable rather than shipping a 170MB browser.
 */

var chromium = require('@sparticuz/chromium');
var puppeteer = require('puppeteer-core');

var _browser = null;

// Reuse the browser across invocations on a warm instance - launching Chrome
// is the expensive part, several seconds cold.
async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1100, height: 1400 },
    executablePath: await chromium.executablePath(),
    headless: true
  });
  return _browser;
}

/**
 * @param {string} html  a complete HTML document
 * @returns {Promise<Buffer>} the rendered PDF
 */
async function htmlToPdf(html) {
  var browser = await getBrowser();
  var page = await browser.newPage();
  try {
    // No network fetches: the document is self-contained, and waiting on
    // external resources is how this hangs until the function times out.
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
    var buf = await page.pdf({
      format: 'Letter',
      printBackground: true,          // the coloured header bar and boxes
      margin: { top: '0.3in', right: '0.3in', bottom: '0.3in', left: '0.3in' },
      preferCSSPageSize: false
    });
    // puppeteer v23 hands back a Uint8Array. Buffer.toString('base64') works;
    // Uint8Array.toString() ignores its argument and yields "37,80,68,...",
    // which would ship a corrupt attachment, so normalise here.
    return Buffer.from(buf);
  } finally {
    await page.close().catch(function () {});
  }
}

module.exports = { htmlToPdf: htmlToPdf };
