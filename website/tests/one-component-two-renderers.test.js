/**
 * THE TWO RENDERERS MUST PRODUCE THE SAME THING, AND THIS PROVES IT.
 *
 * The site builds its components twice: HTML strings at deploy time, DOM nodes
 * in the browser. Fifty-four CSS classes are emitted by both producers, and on
 * 2026-09-01 that shipped four visible defects in one day -- literal `${UNIT}`
 * on every token page, "ETH" on an NVDA pair, "by <treasury>" after the card
 * had been corrected to credit the creator, and a cover link that redirected
 * after the other copy had been fixed not to.
 *
 * Every one of them was invisible to tests that read only the built HTML.
 *
 * So this test does the thing those tests could not: it renders ONE
 * description through BOTH renderers and compares the results. It cannot pass
 * while the two disagree, which is the only guarantee worth having here.
 *
 * The DOM side runs against a small document stub rather than a browser. That
 * is deliberate and it is safe, because the stub implements only
 * `createElement`, `createTextNode`, `setAttribute` and `append` -- it cannot
 * flatter the renderer, since anything it gets wrong shows up as a difference
 * from the string output, which is produced by entirely separate code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

/** The narrowest document that `toDom` can be driven against. */
function makeDocument() {
  const serialise = (node) => {
    if (node.text !== undefined) {
      return String(node.text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
    const attrs = node.attrs.map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')}"`)).join('');
    if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
    return `<${node.tag}${attrs}>${node.children.map(serialise).join('')}</${node.tag}>`;
  };

  return {
    createElement(tag) {
      const node = {
        tag,
        attrs: [],
        children: [],
        setAttribute(name, value) {
          this.attrs.push([name, value]);
        },
        append(...kids) {
          this.children.push(...kids);
        },
        toHtmlString() {
          return serialise(this);
        },
      };
      return node;
    },
    createTextNode(text) {
      return { text };
    },
  };
}

test('one description renders identically as a string and as DOM', async () => {
  const { h, toHtml, toDom } = await import('../assets/markup.mjs');
  const doc = makeDocument();

  const cases = [
    h('p', {}, 'plain'),
    h('div', { class: 'a b', 'data-x': '' }, h('span', {}, 'nested')),
    h('a', { href: '/token/0xabc/', 'aria-label': 'Inspect Micro Duck' }),
    // Attacker-shaped metadata, which is the whole reason the client may not
    // use innerHTML. Both renderers must neutralise it, by different means.
    h('h3', {}, '<img src=x onerror=alert(1)>'),
    h('p', { title: 'quote " and \' apostrophe & ampersand' }, 'x'),
    h('div', {}, null, undefined, false, '', 'only this survives'),
    h('progress', { max: '100', value: '12.5' }, '12.50%'),
  ];

  for (const node of cases) {
    assert.equal(toDom(node, doc).toHtmlString(), toHtml(node), `renderers disagree on <${node.tag}>`);
  }
});

test('the launchpad card is one component, rendered two ways', async () => {
  const { toHtml, toDom, h } = await import('../assets/markup.mjs');
  const { launchpadCard, curveProgress, tokenHref } = await import('../assets/cards.mjs');
  const doc = makeDocument();

  const token = {
    token: '0xC9158abf265aa26766154269f9B3d417f7771D0A',
    name: 'Microduck',
    symbol: 'MICRODUCK',
    creator: '0xcdce6c82d995d3223d4e956a3c28d36bad875dc0',
    deployer: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
    blockTimestamp: '2026-08-30T13:28:00.000Z',
    reserves: { realQuoteReserveWei: '2000000000000000000' },
    graduationThreshold: '8000000000000000000',
  };

  const model = launchpadCard({
    token,
    art: h('div', { class: 'art-grid' }, 'M'),
    marketCapLabel: 'Market cap unavailable',
    relativeTime: '1d ago',
  });

  const asString = toHtml(model);
  assert.equal(toDom(model, doc).toHtmlString(), asString, 'the card renders differently in the two paths');

  // The four things that had actually drifted, asserted on the one output.
  assert.match(asString, /href="\/token\/0xc9158abf265aa26766154269f9b3d417f7771d0a\/"/, 'the cover link must not redirect');
  assert.match(asString, /creator 0xcdce6c/, 'the card must credit the creator, not the sender');
  assert.match(asString, /25\.00% to graduation/, 'the percentage must say what it is');
  assert.match(asString, /aria-label="Bonding curve progress to graduation"/);

  // And the arithmetic that existed twice.
  assert.equal(curveProgress(token), 25);
  assert.equal(curveProgress({ graduationThreshold: '0' }), 0, 'an unknown denominator is not a full bar');
  assert.equal(curveProgress({}), 0);
  assert.equal(tokenHref(token), '/token/0xc9158abf265aa26766154269f9b3d417f7771d0a/');
});

test('a token named as an attack renders as text in both paths', async () => {
  const { toHtml, toDom, h } = await import('../assets/markup.mjs');
  const { launchpadCard } = await import('../assets/cards.mjs');
  const doc = makeDocument();

  const hostile = {
    token: '0x' + 'a'.repeat(40),
    name: '<script>alert(1)</script>',
    symbol: '"><img src=x onerror=alert(1)>',
    deployer: '0x' + 'b'.repeat(40),
    blockTimestamp: '',
    reserves: { realQuoteReserveWei: '0' },
    graduationThreshold: '1',
  };
  const model = launchpadCard({
    token: hostile,
    art: null,
    marketCapLabel: 'Market cap unavailable',
    relativeTime: 'just now',
  });

  const asString = toHtml(model);
  assert.equal(toDom(model, doc).toHtmlString(), asString);
  // The property is that hostile metadata cannot BECOME markup, not that its
  // letters vanish. `onerror=alert` survives escaping as inert text and
  // asserting its absence tests the wrong thing -- it would fail on output that
  // is perfectly safe, which is how a guard gets loosened by whoever meets it
  // next. What matters is that every angle bracket and quote from the data is
  // an entity, so no tag and no attribute can be formed.
  assert.doesNotMatch(asString, /<script>/, 'a token name became markup');
  assert.doesNotMatch(asString, /<img /, 'a token symbol became a tag');
  assert.match(asString, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(asString, /\$&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);

  // And the same in the DOM path, where safety comes from createTextNode
  // rather than from escaping: the name must be one text node, not elements.
  const domCard = toDom(model, doc);
  const symbol = JSON.stringify(domCard);
  assert.ok(!symbol.includes('"tag":"img"'), 'the DOM path created an element from token metadata');
  assert.ok(!symbol.includes('"tag":"script"'));
});
