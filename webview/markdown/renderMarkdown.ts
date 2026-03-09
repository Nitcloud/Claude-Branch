/**
 * Markdown rendering using marked + DOMPurify.
 * Matches the original Claude Code extension's rendering pipeline.
 */

import { marked, type MarkedOptions, type TokenizerAndRendererExtension } from "marked";
import DOMPurify from "dompurify";

// Configure marked once
const renderer = new marked.Renderer();

// Custom link rendering — open in new tab, safe URLs only
renderer.link = ({ href, title, text }) => {
  const safeHref = sanitizeUrl(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttr} draggable="false" target="_blank" rel="noopener noreferrer">${text}</a>`;
};

// Custom code block rendering
renderer.code = ({ text, lang }) => {
  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  const escaped = escapeHtml(text);
  return `<pre><code${langClass}>${escaped}</code></pre>`;
};

// Custom image rendering — safe URLs only
renderer.image = ({ href, title, text }) => {
  const safeHref = sanitizeUrl(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttr}>`;
};

// Set up marked options
marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
} satisfies MarkedOptions);

// DOMPurify configuration — matching original extension's allowlist
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "em", "del", "s",
    "a", "img",
    "code", "pre",
    "blockquote",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td",
    "div", "span",
    "input", // for task list checkboxes
    "sup", "sub",
  ],
  ALLOWED_ATTR: [
    "align", "alt", "checked", "class", "colspan",
    "disabled", "draggable", "height", "href",
    "rowspan", "src", "style", "target",
    "title", "type", "width", "start",
    "rel",
  ],
  ALLOW_DATA_ATTR: false,
};

/**
 * Render markdown text to sanitized HTML.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";

  // Parse markdown to HTML
  const rawHtml = marked.parse(text, { async: false }) as string;

  // Sanitize with DOMPurify
  const clean = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG) as unknown as string;

  return clean;
}

// ---- Helpers ----

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_URL_RE = /^(https?:|mailto:|#|\/)/i;

function sanitizeUrl(url: string): string {
  if (!url) return "";
  if (SAFE_URL_RE.test(url)) return url;
  // Block javascript:, data:, vbscript: etc.
  return "";
}
