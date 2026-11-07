import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("all external JavaScript and stylesheet assets use Subresource Integrity", () => {
  const externalTags = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']https:[^"']+["'][^>]*>/gi),
    ...html.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']https:)[^>]*>/gi)
  ].map(match => match[0]);

  assert.ok(externalTags.length >= 4, "expected the Leaflet and Leaflet Draw CDN assets to be present");
  for (const tag of externalTags) {
    assert.match(tag, /\bintegrity=["']sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}["']/i,
      "external asset must have a valid SRI attribute: " + tag);
    assert.match(tag, /\bcrossorigin=["']anonymous["']/i,
      "external SRI asset must use anonymous CORS mode: " + tag);
    assert.match(tag, /\breferrerpolicy=["']no-referrer["']/i,
      "external asset must not receive a referrer: " + tag);
  }
});

test("Leaflet Draw assets are pinned to the audited 1.0.4 CDN bytes", () => {
  assert.match(html, /leaflet\.draw\.css["'][^>]*integrity=["']sha512-gc3xjCmIy673V6MyOAZhIW93xhM9ei1I\+gLbmFjUHIjocENRsLX\/QUE1htk5q1XV2D\/iie\/VQ8DXI6Vu8bexvQ==["']/);
  assert.match(html, /leaflet\.draw\.js["'][^>]*integrity=["']sha512-ozq8xQKq6urvuU6jNgkfqAmT7jKN2XumbrX1JiB3TnF7tI48DPI4Gy1GXKD\/V3EExgAs1V\+pRO7vwtS1LHg0Gw==["']/);
});


test("CSP permits the CDN host used by SRI-pinned Leaflet Draw assets", () => {
  for (const directive of ["imgSrc", "scriptSrc", "styleSrc"]) {
    const pattern = new RegExp(directive + ":\\s*\\[[^\\]]*\"https://cdnjs\\.cloudflare\\.com\"");
    assert.match(server, pattern, directive + " must allow the Leaflet Draw CDN host");
  }
});


test("dashboard escapes untrusted values before inserting generated HTML", () => {
  assert.match(dashboard, /function esc\(s=""\)\{return String\(s\)\.replace\(\/\[&<>"'\]\//,
    "dashboard HTML escaping must cover ampersand, angle brackets, quotes, and apostrophes");

  for (const field of [
    "esc(a.id)", "esc(a.headline)", "esc(a.event)", "esc(a.workflow)",
    "esc(a.severity)", "esc(scopeLabel)", "esc(a.area_desc)",
    "esc(resource.resourceDesc)", "esc(resource.mimeType)", "esc(resource.size)",
    "esc(resource.language)", "esc(url.href)",
    "esc(row.headline||row.identifier||", "esc(row.last_error)",
    "esc(row.channel)", "esc(row.attempts)", "esc(row.max_attempts)",
    "esc(row.id)", "esc(row.received_at)", "esc(row.reviewer_username)",
    "esc(row.reviewed_at||", "esc(row.review_note)", "esc(row.payload)"
  ]) {
    assert.ok(dashboard.includes(field), "dynamic HTML output must escape " + field);
  }

  assert.equal((dashboard.match(/\.innerHTML\s*=/g) || []).length, 3,
    "review every dashboard HTML insertion point when adding new dynamic templates");
  assert.match(dashboard, /list\.insertAdjacentHTML\("beforeend",html\)/,
    "webhook inbox pagination must append only the escaped template");
});
