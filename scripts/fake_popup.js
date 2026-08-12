// A DOM small enough to run the popup's scripts under Node, built from the ids
// popup.html actually declares.  Asking for an element the page does not have
// throws, so a control the code talks to but the page never declares fails the
// test that uses it.
function createElement(tag = "div") {
  const classes = new Set();
  const attributes = new Map();
  return {
    tagName: tag,
    children: [],
    handlers: {},
    dataset: {},
    textContent: "",
    title: "",
    type: "",
    value: "",
    checked: false,
    files: null,
    hidden: false,
    disabled: false,
    open: false,
    validationMessage: "",
    set className(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
    get className() { return [...classes].join(" "); },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => ((force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name))
    },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    querySelector(selector) {
      const name = selector.replace(/^\./, "");
      for (const child of this.children) {
        if (child.classList?.contains(name)) return child;
        const found = child.querySelector?.(selector);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(selector) {
      const name = selector.replace(/^\./, "");
      return this.children.filter((child) => child.classList?.contains(name));
    },
    closest() { return null; },
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); },
    dispatch(type, event = {}) {
      (this.handlers[type] || []).forEach((handler) => handler({
        preventDefault() {}, target: this, ...event
      }));
    },
    reset() {},
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { return !this.validationMessage; },
    showModal() { this.open = true; },
    close() { this.open = false; this.dispatch("close"); },
    focus() {}
  };
}

function createDocument(html) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const elements = new Map(ids.map((id) => [id, createElement()]));
  return {
    elements,
    visibilityState: "visible",
    addEventListener() {},
    createElement: (tag) => createElement(tag),
    querySelector(selector) {
      if (!selector.startsWith("#")) return null;
      const id = selector.slice(1);
      if (!elements.has(id)) {
        throw new Error(`popup.html has no element with id "${id}"`);
      }
      return elements.get(id);
    }
  };
}

// Let every queued promise chain in the scripts run to completion.
async function settle(rounds = 60) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

module.exports = { createElement, createDocument, settle };
