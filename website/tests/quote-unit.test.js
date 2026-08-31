/**
 * A CURVE AMOUNT IS DENOMINATED IN THE ASSET THE TOKEN IS PAIRED WITH.
 *
 * `ethFromWei` printed " ETH" onto every amount it formatted, and every curve
 * figure on every token page went through it. On PONSR STONKS, paired with
 * native ETH, that is right. On Microduck, paired with NVDA, the live page
 * stated a sell as `-0.320168264216621238 ETH` when not one wei of ETH was
 * involved -- on the page whose entire purpose is evidence a reader can check.
 *
 * The arithmetic was never wrong: NVDA carries 18 decimals like ETH, read from
 * its own contract. Only the label was false, which is exactly why it survived
 * -- every number looked plausible.
 *
 * The pairing asset is what every buyer spends. Naming the wrong one is not a
 * cosmetic slip.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const PSTONKS = '0x7803f37e0db73105c47d5a5f3d054a0ae47e2199';
const MICRODUCK = '0xc9158abf265aa26766154269f9b3d417f7771d0a';
const ZERO = '0x0000000000000000000000000000000000000000';

test('an amount is labelled with the asset it is actually in', async () => {
  const { amountFromWei, quoteUnit, quoteName } = await import('../assets/format.mjs');

  assert.equal(amountFromWei(10n ** 18n, 6, 'NVDA'), '1 NVDA');
  assert.equal(amountFromWei(10n ** 18n), '1 ETH', 'the default must stay ETH');

  assert.equal(quoteUnit({ pairToken: ZERO, pairLabel: 'native ETH' }), 'ETH');
  assert.equal(quoteUnit({ pairToken: '0x' + 'd'.repeat(40), pairLabel: 'NVDA' }), 'NVDA');
  // Prose reads "native ETH"; a number reads "ETH".
  assert.equal(quoteName({ pairToken: ZERO }), 'native ETH');
  assert.equal(quoteName({ pairToken: '0x' + 'd'.repeat(40), pairLabel: 'NVDA' }), 'NVDA');
});

test('an unresolved pair label is never printed as if it were a ticker', async () => {
  const { quoteUnit } = await import('../assets/format.mjs');
  const pair = '0x' + 'd'.repeat(40);
  // "0.5 approved token" reads like a unit and is not one. An unrecognised unit
  // is honest; a wrong ticker is a financial claim.
  for (const label of ['approved token', '', null, undefined, '<script>', 'a name far too long to be a ticker']) {
    assert.equal(quoteUnit({ pairToken: pair, pairLabel: label }), 'quote', `${label} was printed as a unit`);
  }
});

test('the Microduck page states NVDA, and never ETH, for curve amounts', () => {
  const html = read(`website/token/${MICRODUCK}/index.html`);
  assert.match(html, /Net NVDA flow/);
  assert.match(html, /Quote out −[\d.]+ NVDA/);
  assert.match(html, /See how much NVDA entered/);
  // Not one curve figure may still claim ETH. The launch FEE is genuinely ETH,
  // so it is excluded rather than the assertion being softened.
  const withoutLaunchFee = html.replace(/Launch fee<\/[^>]+>[\s\S]{0,120}?ETH/g, '');
  assert.doesNotMatch(withoutLaunchFee, /Quote (?:in \+|out −)[\d.]+ ETH/);
  assert.doesNotMatch(withoutLaunchFee, /Net ETH flow/);
});

test('the PONSR STONKS page is not touched by any of this', () => {
  const html = read(`website/token/${PSTONKS}/index.html`);
  // Its pair IS native ETH, so every word it had must survive unchanged --
  // including "native", which an earlier attempt at this fix silently dropped.
  assert.match(html, /Net ETH flow/);
  assert.match(html, /See how much native ETH entered/);
  assert.match(html, /Quote in \+[\d.]+ ETH/);
  assert.doesNotMatch(html, /NVDA/);
});

test('no renderer hardcodes the unit onto a curve amount', () => {
  for (const file of ['scripts/build-website.mjs', 'website/assets/app.mjs']) {
    const source = read(file);
    // The formatter that bakes in ETH may not be used for a quote amount.
    assert.doesNotMatch(source, /ethFromWei\((?:event|buyWei|sellWei|maxWei|netWei|absNet|token\.reserves|token\.graduationThreshold)/,
      `${file} formats a quote amount with the ETH-only formatter`);
    // Nor may a bare literal stand in for the unit beside one.
    assert.doesNotMatch(source, /flow-scale-zero'?,?\s*'0 ETH'/, `${file} hardcodes a zero label`);
    assert.doesNotMatch(source, /Net ETH flow/, `${file} hardcodes the flow heading`);
  }
});
