// dom.js: tiny helpers for building screens. Text always goes in as text, never as HTML,
// so a label like "<b>hi</b>" shows exactly as typed.

// el('button', {class: 'btn', onclick: fn, text: 'Stop'}, [child, child])
// Attribute values of null, undefined or false are skipped. Names starting with "on" add listeners.
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
  }
  if (children !== undefined && children !== null) {
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Sets the three colour variables of one category slot (1 to 9) on an element.
// Anything outside 1 to 9 falls back to slot 9, the slate grey.
export function catStyle(slot) {
  const n = Number.isInteger(slot) && slot >= 1 && slot <= 9 ? slot : 9;
  return '--c: var(--cat-' + n + '); --cf: var(--cat-' + n + '-fill); --cl: var(--cat-' + n + '-line);';
}
