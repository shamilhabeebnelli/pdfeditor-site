// E2E: drives the real UI in headless Chrome against a local static server.
import { chromium } from 'playwright-core';
import { spawn as sp } from 'node:child_process';

const DIR = '/downloads/pdf-editor';
const PORT = 8901;
const server = sp('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: DIR, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
check('page loads', await page.locator('.logo').count() === 1);

// 1. open sample.pdf
await page.setInputFiles('#file', `${DIR}/test/sample.pdf`);
await page.waitForSelector('.textzone', { timeout: 15000 });
const zoneCount = await page.locator('.textzone').count();
check('text zones rendered', zoneCount >= 2, `(${zoneCount})`);
await page.screenshot({ path: `${DIR}/test/shot-1-loaded.png` });

// 2. edit first text line
await page.locator('.textzone').first().click();
const editbox = page.locator('input.editbox');
await editbox.waitFor({ timeout: 5000 });
const prefilled = await editbox.inputValue();
check('edit box prefilled with original text', prefilled === 'Invoice total: USD 1,250.00', JSON.stringify(prefilled));
const fontShown = await editbox.evaluate((el) => el.style.font);
check('edit box uses mapped serif font', /times/i.test(fontShown), fontShown);
// bold+underline+strike toggles in the edit bar, then commit
await page.locator('.editbar button').nth(0).click(); // B
await page.locator('.editbar button.u').click();
await page.locator('.editbar button.s').click();
// longer replacement must trigger the overflow confirmation, not silent cover
await editbox.fill('Invoice total: USD 9,999.00 (settled in full today)');
await editbox.press('Enter');
const ovf = page.locator('.ovfbar');
await ovf.waitFor({ timeout: 5000 });
check('overflow warning shown for wider replacement', true);
// cancel path: no stamp, zone reusable
await page.locator('.ovfbar button:not(.warnapply)').click();
check('overflow cancel leaves no stamp', await page.locator('.tstamp').count() === 0);
// redo and accept
await page.locator('.textzone').first().click();
const editbox2 = page.locator('input.editbox');
await editbox2.waitFor({ timeout: 5000 });
await page.locator('.editbar button').nth(0).click(); // B
await page.locator('.editbar button.u').click();
await page.locator('.editbar button.s').click();
await editbox2.fill('Invoice total: USD 9,999.00 (settled in full today)');
await editbox2.press('Enter');
await page.locator('.ovfbar button.warnapply').click();
check('stamp appears after cover-anyway', await page.locator('.tstamp').count() === 1);
const stampWeight = await page.locator('.tstamp').first().evaluate((el) => getComputedStyle(el).fontWeight);
check('bold toggle reflected in stamp', stampWeight === '700' || stampWeight === 'bold', stampWeight);
const stampDeco = await page.locator('.tstamp').first().evaluate((el) => getComputedStyle(el).textDecorationLine);
check('underline+strike reflected in stamp', /underline/.test(stampDeco) && /line-through/.test(stampDeco), stampDeco);

// 3. whiteout drag over second line
await page.locator('button[data-tool="whiteout"]').click();
const overlay = page.locator('.overlay').first();
const obox = await overlay.boundingBox();
await page.mouse.move(obox.x + 45, obox.y + 126); await page.mouse.down();
await page.mouse.move(obox.x + 260, obox.y + 144, { steps: 5 }); await page.mouse.up();
// coordinates are viewport-absolute; overlay is below header, second text line ~ there
const wrects = await page.locator('.wrect').count();
check('whiteout rectangle created', wrects >= 1, `(${wrects})`);
await page.screenshot({ path: `${DIR}/test/shot-2-edited.png`, fullPage: false });

// 4. add text tool (multiline textarea now; Ctrl+Enter commits)
await page.locator('button[data-tool="addtext"]').click();
await page.mouse.click(obox.x + 80, obox.y + 300);
const addbox = page.locator('.editbox');
await addbox.waitFor({ timeout: 5000 });
await addbox.type('PAID');
await addbox.press('Control+Enter');
check('add-text stamp appears', await page.locator('.tstamp').count() === 2);

// 4b. bulleted multi-line list
await page.locator('button[data-tool="addtext"]').click();
await page.mouse.click(obox.x + 80, obox.y + 400);
const listbox = page.locator('.editbox');
await listbox.waitFor({ timeout: 5000 });
await listbox.type('Milk\nEggs');
await page.locator('.editbar button.bl').click();
await listbox.press('Control+Enter');
const listStamp = page.locator('.tstamp').nth(2);
await listStamp.waitFor({ timeout: 5000 });
const listTxt = await listStamp.textContent();
check('bulleted list stamp shows bullets and lines', /\u2022 Milk/.test(listTxt) && /\u2022 Eggs/.test(listTxt), JSON.stringify(listTxt));

// 5. undo removes last op
await page.locator('#undo').click();
check('undo removes list', await page.locator('.tstamp').count() === 2);
// re-add list for the export
await page.locator('button[data-tool="addtext"]').click();
await page.mouse.click(obox.x + 80, obox.y + 400);
const listbox2 = page.locator('.editbox');
await listbox2.waitFor({ timeout: 5000 });
await listbox2.type('Milk\nEggs');
await page.locator('.editbar button.bl').click();
await listbox2.press('Control+Enter');
check('list re-added', await page.locator('.tstamp').count() === 3);

// 6. normal export
const dl1 = page.waitForEvent('download', { timeout: 20000 });
await page.locator('#export').click();
const d1 = await dl1;
await d1.saveAs(`${DIR}/test/e2e-export.pdf`);
check('normal export downloads', true, d1.suggestedFilename());

// 7. flatten export
await page.locator('#flattenChk').check();
const dl2 = page.waitForEvent('download', { timeout: 30000 });
await page.locator('#export').click();
const d2 = await dl2;
await d2.saveAs(`${DIR}/test/e2e-flattened.pdf`);
check('flatten export downloads', true, d2.suggestedFilename());

// 8. custom embedded font: substitution notice must appear when clicking a zone
await page.locator('button[data-tool="edit"]').click();
await page.setInputFiles('#file', `${DIR}/test/custom-font.pdf`);
await page.waitForSelector('.textzone', { timeout: 15000 });
await page.locator('.textzone').first().click();
await page.waitForSelector('.substnote', { timeout: 5000 });
check('font substitution notice shown for embedded font', true);
await page.keyboard.press('Escape');

// 9. scanned PDF notice
await page.setInputFiles('#file', `${DIR}/test/scanned.pdf`);
await page.waitForTimeout(3000);
const noticeTxt = await page.locator('#notice').textContent().catch(() => '');
check('scanned-PDF notice shown', /scanned/i.test(noticeTxt || ''), (noticeTxt || '').slice(0, 60));
await page.screenshot({ path: `${DIR}/test/shot-3-scanned.png` });

// 10. matching evidence pair: one edit, UI shot + its own exported render
await page.locator('button[data-tool="edit"]').click();
await page.setInputFiles('#file', `${DIR}/test/sample.pdf`);
await page.waitForSelector('.textzone', { timeout: 15000 });
await page.locator('.textzone').first().click();
const evbox = page.locator('input.editbox');
await evbox.waitFor({ timeout: 5000 });
await evbox.fill('Invoice total: USD 1,480.00');
await evbox.press('Enter');
await page.waitForSelector('.tstamp', { timeout: 5000 });
await page.screenshot({ path: `${DIR}/test/shot-evidence-ui.png` });
await page.locator('#flattenChk').uncheck(); // evidence pair must be a NORMAL export
const dl3 = page.waitForEvent('download', { timeout: 20000 });
await page.locator('#export').click();
await (await dl3).saveAs(`${DIR}/test/evidence-export.pdf`);
check('evidence export downloads', true);

check('no JS errors', errors.length === 0, errors.join(' | ').slice(0, 300));

console.log(results.join('\n'));
await browser.close();
server.kill();
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
