/**
 * @unipi/web-api — DOM Parsing
 *
 * Server-side DOM parsing using linkedom.
 * Provides polyfills for defuddle compatibility.
 */

import { parseHTML as linkedomParseHTML } from "linkedom";

/**
 * Parse HTML into a DOM document.
 * Returns a document compatible with defuddle extraction.
 *
 * @param html - HTML string to parse
 * @returns DOM document and window
 */
export function parseHTML(html: string): {
  document: Document;
  window: Window & typeof globalThis;
} {
  const { window } = linkedomParseHTML(html);

  // Apply polyfills for defuddle compatibility
  applyPolyfills(window);

  return {
    document: window.document,
    window,
  };
}

/**
 * Apply polyfills to the window object for defuddle compatibility.
 * Defuddle expects certain browser APIs that linkedom may not provide.
 *
 * @param window - Window object to polyfill
 */
function applyPolyfills(window: Window & typeof globalThis): void {
  // NodeList.forEach is often expected but may not be in linkedom
  const NodeList = (window as any).NodeList;
  if (NodeList && !NodeList.prototype.forEach) {
    NodeList.prototype.forEach = function (callback: (value: Node, key: number, parent: NodeList) => void, thisArg?: any): void {
      for (let i = 0; i < this.length; i++) {
        callback.call(thisArg, this.item(i), i, this);
      }
    };
  }

  // Element.matches polyfill
  const Element = (window as any).Element;

  if (Element && Element.prototype) {
    if (!Element.prototype.matches) {
      Element.prototype.matches = function (selector: string): boolean {
        const doc = this.ownerDocument;
        if (!doc) return false;
        const matches = doc.querySelectorAll(selector);
        for (let i = 0; i < matches.length; i++) {
          if (matches[i] === this) return true;
        }
        return false;
      };
    }

    // Element.closest polyfill
    if (!Element.prototype.closest) {
      Element.prototype.closest = function (selector: string): Element | null {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let el: Element | null = this;
        while (el) {
          if (el.matches && el.matches(selector)) {
            return el;
          }
          el = el.parentElement;
        }
        return null;
      };
    }
  }

  // TextDecoder/TextEncoder polyfill (Node has these natively, but just in case)
  if (typeof (window as any).TextDecoder === "undefined") {
    (window as any).TextDecoder = globalThis.TextDecoder;
  }
  if (typeof (window as any).TextEncoder === "undefined") {
    (window as any).TextEncoder = globalThis.TextEncoder;
  }

  // URL polyfill
  if (typeof (window as any).URL === "undefined") {
    (window as any).URL = globalThis.URL;
  }

  // console polyfill (linkedom may not provide)
  if (typeof (window as any).console === "undefined") {
    (window as any).console = console;
  }
}

/**
 * Extract text content from a DOM element.
 * Walks text nodes and concatenates their content.
 *
 * @param element - Root element to extract from
 * @returns Extracted text
 */
export function extractTextContent(element: Element): string {
  const texts: string[] = [];

  function walk(node: Node): void {
    if (node.nodeType === 3) {
      // Text node
      const text = node.textContent?.trim();
      if (text) {
        texts.push(text);
      }
    } else if (node.nodeType === 1) {
      // Element node
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    }
  }

  walk(element);

  return texts.join(" ");
}

/**
 * Convert a DOM element to markdown.
 * Basic implementation for fallback extraction.
 *
 * @param element - Root element to convert
 * @returns Markdown string
 */
export function elementToMarkdown(element: Element): string {
  const lines: string[] = [];

  function walk(node: Node, depth: number = 0): void {
    if (node.nodeType === 3) {
      // Text node
      const text = node.textContent?.trim();
      if (text) {
        lines.push(text);
      }
    } else if (node.nodeType === 1) {
      // Element node
      const el = node as Element;
      const tag = el.tagName?.toLowerCase();

      switch (tag) {
        case "h1":
          lines.push("");
          lines.push(`# ${extractTextContent(el)}`);
          lines.push("");
          break;
        case "h2":
          lines.push("");
          lines.push(`## ${extractTextContent(el)}`);
          lines.push("");
          break;
        case "h3":
          lines.push("");
          lines.push(`### ${extractTextContent(el)}`);
          lines.push("");
          break;
        case "h4":
        case "h5":
        case "h6":
          lines.push("");
          lines.push(`${"#".repeat(parseInt(tag[1]))} ${extractTextContent(el)}`);
          lines.push("");
          break;
        case "p":
          lines.push("");
          lines.push(extractTextContent(el));
          lines.push("");
          break;
        case "br":
          lines.push("");
          break;
        case "a": {
          const href = el.getAttribute("href");
          const text = extractTextContent(el);
          if (href && text) {
            lines.push(`[${text}](${href})`);
          } else if (text) {
            lines.push(text);
          }
          break;
        }
        case "strong":
        case "b":
          lines.push(`**${extractTextContent(el)}**`);
          break;
        case "em":
        case "i":
          lines.push(`*${extractTextContent(el)}*`);
          break;
        case "code":
          lines.push(`\`${extractTextContent(el)}\``);
          break;
        case "pre":
          lines.push("");
          lines.push("```");
          lines.push(extractTextContent(el));
          lines.push("```");
          lines.push("");
          break;
        case "blockquote":
          lines.push("");
          for (const line of extractTextContent(el).split("\n")) {
            lines.push(`> ${line}`);
          }
          lines.push("");
          break;
        case "ul":
        case "ol":
          lines.push("");
          for (const child of Array.from(el.children)) {
            walk(child, depth + 1);
          }
          lines.push("");
          break;
        case "li": {
          const prefix = depth > 0 ? "  " : "";
          lines.push(`${prefix}- ${extractTextContent(el)}`);
          break;
        }
        case "img": {
          const alt = el.getAttribute("alt") || "";
          const src = el.getAttribute("src") || "";
          lines.push(`![${alt}](${src})`);
          break;
        }
        case "div":
        case "section":
        case "article":
        case "main":
        case "header":
        case "footer":
        case "nav":
        case "aside":
          // Container elements - recurse into children
          for (const child of Array.from(el.childNodes)) {
            walk(child, depth);
          }
          break;
        default:
          // Unknown elements - recurse into children
          for (const child of Array.from(el.childNodes)) {
            walk(child, depth);
          }
          break;
      }
    }
  }

  walk(element);

  // Clean up multiple blank lines
  let result = lines.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}
