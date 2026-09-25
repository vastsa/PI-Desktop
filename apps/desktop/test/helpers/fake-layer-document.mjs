/**
 * Just enough of a document for the plugin layer stack
 * (`src/plugins/renderer-layers/layer-stack.ts`): elements with attributes,
 * inline style, children and `remove()`, under a `body`.
 */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.hidden = false;
    this.inert = false;
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
}

export function fakeLayerDocument() {
  return {
    body: new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
  };
}
