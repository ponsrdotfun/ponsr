export function setText(node, value) { node.textContent = value == null ? 'Unknown' : String(value); return node; }
export function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) setText(node, text); return node; }
export function externalLink(label, href) { const a = element('a', 'text-link', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
