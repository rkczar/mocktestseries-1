/**
 * Serialize structured data for `<script type="application/ld+json">`.
 * Plain JSON.stringify leaves `<` intact, so admin-editable text such as
 * "</script><script>…" would close the tag and run as HTML. Escaping the
 * HTML-significant characters (and the JS line separators) keeps the output
 * valid JSON that can never break out of the script element.
 */
const LS = String.fromCharCode(0x2028);
const LINE_SEPARATORS = new RegExp(`[${LS}${String.fromCharCode(0x2029)}]`, "g");

export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEPARATORS, (c) => (c === LS ? "\\u2028" : "\\u2029"));
}
