/**
 * Shared XML DOM Utilities
 *
 * Helpers for querying XML documents and elements with namespace resilience.
 */

/**
 * Returns text content of the first direct child element with the given local/tag name.
 *
 * @param {Element|Node} parent - Parent XML element
 * @param {string} tagName - Tag name or localName to find
 * @returns {string|null} Trimmed text content, or null if not found
 */
export function getDirectChildText(parent, tagName) {
  if (!parent) return null;
  const children = parent.children || parent.childNodes;
  for (const child of children) {
    if (child.nodeType === 1 && (child.localName === tagName || child.tagName === tagName)) {
      return child.textContent.trim();
    }
  }
  return null;
}

/**
 * Returns text content of the first element matching tagName in a document or element context.
 *
 * @param {Document|Element} doc - Document or Element to search within
 * @param {string} tagName - Tag name to match
 * @returns {string|null} Trimmed text content, or null if not found
 */
export function getXmlText(doc, tagName) {
  if (!doc || typeof doc.getElementsByTagName !== "function") return null;
  const el = doc.getElementsByTagName(tagName)[0];
  return el ? el.textContent.trim() : null;
}
