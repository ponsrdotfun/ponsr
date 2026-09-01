/**
 * ONE DESCRIPTION OF A COMPONENT, RENDERED TWO WAYS.
 *
 * This site builds the same components twice: `scripts/build-website.mjs`
 * writes HTML strings at deploy time, and `app.mjs` builds DOM nodes in the
 * browser when live data arrives. Fifty-four CSS classes are emitted by both.
 *
 * On 2026-09-01 that produced four visible defects in a single day, every one
 * of them a divergence between the two copies and every one of them invisible
 * to tests that read only the built HTML:
 *
 *   1. `${UNIT}` and `${quoteName(token)}` printed literally on every token
 *      page -- the build script's copy of the same legend was correct.
 *   2. "cumulative ETH movement" on a token paired with NVDA, where the build
 *      script's copy said `${esc(unit)}`.
 *   3. The explore card said "by <treasury>" after the build script had been
 *      corrected to credit the creator.
 *   4. The card's cover link -- the main clickable target of every card --
 *      still pointed at the redirecting URL after the build script's copy was
 *      fixed to name the served one.
 *
 * A component described ONCE cannot drift from itself. That is the whole idea
 * here, and it is the smallest change that removes the class of bug rather than
 * its instances.
 *
 * WHY A DESCRIPTION AND NOT A TEMPLATE STRING
 * -------------------------------------------
 * The obvious alternative is to share the HTML string and set `innerHTML` in
 * the browser. A test in this repository forbids that, and it is right to:
 * every value on these pages is attacker-influenced token metadata, and an
 * innerHTML sink is how a token named `<img onerror=…>` becomes a script.
 * A description renders to text nodes and attributes on the client, so the
 * escaping question never arises there at all.
 *
 * WHAT BELONGS HERE AND WHAT DOES NOT
 * -----------------------------------
 * Structure belongs here. Data policy does not. The two producers legitimately
 * differ about VALUES -- the client can show a market cap the static build has
 * never observed, and it anchors relative time against a clock the build does
 * not have. So a component takes its values as inputs and describes only the
 * shape, which is the half that was drifting.
 */

/** A node description. Children are flattened; null, undefined and false drop out. */
export function h(tag, attrs = {}, ...children) {
  return {
    tag,
    attrs: attrs ?? {},
    children: children
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false && child !== ''),
  };
}

/**
 * HTML escaping, shared so the two sides cannot disagree about it either.
 *
 * `&` first, or every entity written afterwards is escaped a second time.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Attributes that are written as a bare name when true, and omitted when false. */
const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'checked', 'selected', 'required', 'open']);

/** Void elements, which must never be given a closing tag. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Render to an HTML string, for the deploy-time build.
 *
 * A `data-*` attribute whose value is an empty string is written as a bare
 * attribute, matching what `element.dataset.x = ''` produces in the DOM -- so
 * the two renderers agree on `data-protocol-badge` rather than one of them
 * emitting `data-protocol-badge=""`.
 */
export function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node !== 'object') return escapeHtml(node);

  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([name, value]) => {
      if (BOOLEAN_ATTRS.has(name)) return value === true ? ` ${name}` : '';
      if (value === true || value === '') return ` ${name}`;
      return ` ${name}="${escapeHtml(value)}"`;
    })
    .join('');

  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(toHtml).join('')}</${node.tag}>`;
}

/**
 * Render to DOM nodes, for the browser.
 *
 * Text arrives through `createTextNode` and attributes through `setAttribute`,
 * so nothing here can interpret markup in a token's name. That is the property
 * the innerHTML ban exists to protect, kept by construction rather than by
 * remembering to escape.
 */
export function toDom(node, doc = globalThis.document) {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node !== 'object') return doc.createTextNode(String(node));

  const element = doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (BOOLEAN_ATTRS.has(name)) {
      if (value === true) element.setAttribute(name, '');
      continue;
    }
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of node.children) {
    const rendered = toDom(child, doc);
    if (rendered) element.append(rendered);
  }
  return element;
}
