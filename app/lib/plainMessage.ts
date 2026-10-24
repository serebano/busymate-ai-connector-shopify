/**
 * Shopper and assistant messages are Markdown. The admin transcript shows them
 * as plain text, so "**bold**" and "[name](/products/x)" read as stray symbols.
 * This keeps the words and the link targets and drops the markup. The output
 * is still rendered as a React text node (never HTML).
 */
export function plainMessage(body: string): string {
  return body
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => (label.trim() && label.trim() !== url ? `${label} (${url})` : url))
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}
