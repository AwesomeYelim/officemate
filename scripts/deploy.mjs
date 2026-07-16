// Deploy officemate's static HTML pages to namo.site (SiteBuilder) on git push.
//
// Unlike the portfolio repo (single page, CDN-backed assets), officemate is:
//   - all-in-one HTML files (head: title/meta/style, body: markup+script) — no
//     separate css/js tracked by a CDN, so there is no purge track here.
//   - multi-page: 7 root HTML files, each mapped to one namo page.
//
// Page resolution (deterministic, no hardcoded page ids):
//   1. call list_pages
//   2. match by slug (filename without .html, plus known aliases for index)
//   3. if no slug match, fall back to matching remote page title against our
//      <title>...</title>
//   4. if still no match, create_page (title = our <title>), then use the
//      returned id
//   5. update_page_html with the resolved page id
//
// Body payload: SiteBuilder pages don't have their own <head>, so we merge
// this file's <head> <style> block(s) (reset + main CSS) in front of the
// <body> inner content (which already contains any <script> tags — we do
// NOT strip scripts, unlike portfolio, since these pages are single-file
// simulations that rely on their own inline JS).
//
// Env:
//   SB_URL      MCP endpoint (default: the sunbisites cloud function)
//   SB_TOKEN    Bearer token   (required unless DRY_RUN=1)
//   SB_SITE_ID  X-Site-Id header (required unless DRY_RUN=1)
//   CHANGED     newline/space list of changed paths; "ALL" (or empty) = sync everything
//   DRY_RUN     if "1", do not call any API — just print the deploy plan
//     (file -> slug -> planned action, payload byte size) and exit 0.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const SB_URL = process.env.SB_URL || "https://asia-northeast3-sunbisites.cloudfunctions.net/mcp_code_server";
const SB_TOKEN = process.env.SB_TOKEN || "";
const SB_SITE_ID = process.env.SB_SITE_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1";

// Optional base-path prefix for internal links, applied at deploy time.
// The published namo site (https://officemate.namo.site) serves
// pages at root paths (/biz-plan, /landing, ...) — same as Vercel — so the
// default is "" (no rewriting). namo.site/ba4 is only the builder preview,
// NOT the published URL: prefixing links for it 404s on the real subdomain.
// Set SB_PUBLIC_BASE only if the site ever moves under a subpath.
const SB_PUBLIC_BASE = process.env.SB_PUBLIC_BASE ?? "";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- page registry -----------------------------------------------------
// slug = filename without extension. `slugAliases` covers remote pages that
// might use a different slug for the site's home page (namo commonly calls
// it "home" or "" instead of "index").
const PAGES = [
  { file: "index.html", slug: "index", slugAliases: ["home", ""] },
  { file: "landing.html", slug: "landing", slugAliases: [] },
  { file: "biz-plan.html", slug: "biz-plan", slugAliases: [] },
  { file: "hr-console.html", slug: "hr-console", slugAliases: [] },
  { file: "flow-mockup.html", slug: "flow-mockup", slugAliases: [] },
  { file: "journey-mockup.html", slug: "journey-mockup", slugAliases: [] },
  { file: "spec.html", slug: "spec", slugAliases: [] },
];

// --- changed-file detection ---------------------------------------------
// Splits on any run of whitespace/comma characters without using a regex.
function splitList(s) {
  const parts = [];
  let cur = "";
  for (const ch of s) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

const rawChanged = (process.env.CHANGED || "").trim();
const ALL = !rawChanged || rawChanged.toUpperCase() === "ALL";
const changedSet = new Set(ALL ? [] : splitList(rawChanged));

function isTargeted(file) {
  return ALL || changedSet.has(file);
}

// --- string-based HTML extraction (no regex) -----------------------------
// Pulls the text between the first `<tag ...>` (attributes allowed) and the
// matching `</tag>`, scanning with indexOf only.
function extractTag(html, tag) {
  const openNeedle = `<${tag}`;
  const openStart = html.indexOf(openNeedle);
  if (openStart === -1) return null;
  const openEnd = html.indexOf(">", openStart);
  if (openEnd === -1) return null;
  const closeNeedle = `</${tag}>`;
  const closeStart = html.indexOf(closeNeedle, openEnd + 1);
  if (closeStart === -1) return null;
  return {
    inner: html.slice(openEnd + 1, closeStart),
    outerStart: openStart,
    outerEnd: closeStart + closeNeedle.length,
  };
}

// Collects every `<style ...>...</style>` block found within `haystack`
// (searched left to right, non-overlapping).
function extractAllStyleBlocks(haystack) {
  const blocks = [];
  let cursor = 0;
  while (true) {
    const openStart = haystack.indexOf("<style", cursor);
    if (openStart === -1) break;
    const openEnd = haystack.indexOf(">", openStart);
    if (openEnd === -1) break;
    const closeStart = haystack.indexOf("</style>", openEnd + 1);
    if (closeStart === -1) break;
    const closeEnd = closeStart + "</style>".length;
    blocks.push(haystack.slice(openStart, closeEnd));
    cursor = closeEnd;
  }
  return blocks;
}

// Collects every stylesheet <link href="..."> in `haystack` and returns the
// hrefs. SiteBuilder pages have no <head>, so these links would otherwise be
// silently dropped — we re-emit them as a leading <style>@import ...</style>
// block (webfonts like Material Icons / Pretendard break without this).
function extractStylesheetHrefs(haystack) {
  const hrefs = [];
  let cursor = 0;
  while (true) {
    const openStart = haystack.indexOf("<link", cursor);
    if (openStart === -1) break;
    const openEnd = haystack.indexOf(">", openStart);
    if (openEnd === -1) break;
    const tag = haystack.slice(openStart, openEnd + 1);
    cursor = openEnd + 1;
    if (!tag.includes('rel="stylesheet"') && !tag.includes("rel='stylesheet'")) continue;
    const m = tag.indexOf('href="') !== -1
      ? tag.slice(tag.indexOf('href="') + 6, tag.indexOf('"', tag.indexOf('href="') + 6))
      : null;
    if (m) hrefs.push(m);
  }
  return hrefs;
}

// Rewrites internal links for namo. Two concerns:
//  1. The offline bundle links pages as `href="<slug>.html"` so double-clicked
//     files work — namo routes are extensionless (/biz-plan), so rewrite them.
//     Bundled pages also carry the same links escaped inside JS strings
//     (`href=\"biz-plan.html\"`); both forms are covered.
//  2. If SB_PUBLIC_BASE is set (site under a subpath), prefix root-absolute
//     links too. Only known page slugs are touched — external URLs, anchors,
//     and asset paths pass through unchanged. Exact-string replacement.
function rewriteInternalLinks(html) {
  let out = html;
  for (const p of PAGES) {
    out = out
      .replaceAll(`href="${p.slug}.html"`, `href="${SB_PUBLIC_BASE}/${p.slug}"`)
      .replaceAll(`href=\\"${p.slug}.html\\"`, `href=\\"${SB_PUBLIC_BASE}/${p.slug}\\"`);
  }
  if (!SB_PUBLIC_BASE) return out;
  for (const p of PAGES) {
    // covers href="/slug" and href="/slug#anchor"
    out = out
      .replaceAll(`href="/${p.slug}"`, `href="${SB_PUBLIC_BASE}/${p.slug}"`)
      .replaceAll(`href="/${p.slug}#`, `href="${SB_PUBLIC_BASE}/${p.slug}#`);
  }
  out = out.replaceAll(`href="/"`, `href="${SB_PUBLIC_BASE}"`);
  return out;
}

// Collects every `<script ...>...</script>` block within `haystack`
// (left to right, non-overlapping), mirroring extractAllStyleBlocks.
function extractAllScriptBlocks(haystack) {
  const blocks = [];
  let cursor = 0;
  while (true) {
    const openStart = haystack.indexOf("<script", cursor);
    if (openStart === -1) break;
    const openEnd = haystack.indexOf(">", openStart);
    if (openEnd === -1) break;
    const closeStart = haystack.indexOf("</script>", openEnd + 1);
    if (closeStart === -1) break;
    const closeEnd = closeStart + "</script>".length;
    blocks.push(haystack.slice(openStart, closeEnd));
    cursor = closeEnd;
  }
  return blocks;
}

// --- offline-bundle unbundling -------------------------------------------
// The redesigned pages are ~4.3MB self-contained bundles: the real document
// lives as a JSON string in <script type="__bundler/template">, fonts + the
// dc-runtime app JS live uuid-keyed in <script type="__bundler/manifest">.
// namo's backend rejects multi-MB payloads (Firestore-style entity limit),
// so for deployment we reconstruct the original ~130KB document: inline the
// app JS (gunzip), and swap the uuid-src @font-face blocks for the same
// fonts loaded from their CDNs. The dc-runtime supports running unbundled —
// without window.__resources it loads React from unpkg by itself.
function extractBundlerBlock(raw, type) {
  const marker = `<script type="__bundler/${type}">`;
  const start = raw.indexOf(marker);
  if (start === -1) return null;
  const end = raw.indexOf("</script>", start);
  if (end === -1) return null;
  return raw.slice(start + marker.length, end).trim();
}

const PRETENDARD_IMPORT =
  '<style>@import url("https://cdn.jsdelivr.net/gh/orioncactus/pretendard@1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css");</style>';
const MATERIAL_IMPORT =
  '<style>@import url("https://fonts.googleapis.com/icon?family=Material+Icons");</style>';

function unbundle(raw, file) {
  const tplRaw = extractBundlerBlock(raw, "template");
  const manRaw = extractBundlerBlock(raw, "manifest");
  if (!tplRaw || !manRaw) return null;
  let tpl = JSON.parse(tplRaw);
  const manifest = JSON.parse(manRaw);
  // 1) local JS resources referenced as <script src="<uuid>"> → inline them
  for (const [uuid, res] of Object.entries(manifest)) {
    const tag = `<script src="${uuid}"></script>`;
    if (res.mime !== "text/javascript" || !tpl.includes(tag)) continue;
    let buf = Buffer.from(res.data, "base64");
    if (res.compressed) buf = gunzipSync(buf);
    const js = buf.toString("utf8").split("</script").join("<\\/script");
    tpl = tpl.replace(tag, `<script>\n${js}\n</script>`);
  }
  // 2) uuid-src font blocks → same fonts via CDN
  for (const block of extractAllStyleBlocks(tpl)) {
    if (!block.includes("format('woff2')")) continue;
    if (block.includes("Pretendard")) tpl = tpl.replace(block, PRETENDARD_IMPORT);
    else if (block.includes("Material Icons")) tpl = tpl.replace(block, MATERIAL_IMPORT);
  }
  console.log(`  ${file}: unbundled offline bundle -> ${Buffer.byteLength(tpl, "utf8")} bytes document`);
  return tpl;
}

// namo's SPA shell owns the document <head>, so a <link rel="icon"> in our
// source files never reaches the served page. Instead, emit a tiny script
// that swaps the favicon at runtime with the data-URI icon found in the
// source file's head. Returns "" when the source has no icon link.
function faviconScript(raw) {
  const head = extractTag(raw, "head");
  if (!head) return "";
  const linkStart = head.inner.indexOf('<link rel="icon"');
  if (linkStart === -1) return "";
  const hrefStart = head.inner.indexOf('href="', linkStart);
  if (hrefStart === -1) return "";
  const start = hrefStart + 'href="'.length;
  const end = head.inner.indexOf('"', start);
  const href = head.inner.slice(start, end);
  return (
    `<script>(function(){var l=document.querySelector('link[rel~="icon"]')||document.createElement('link');` +
    `l.rel='icon';l.type='image/png';l.href='${href}';` +
    `if(!l.parentNode)document.head.appendChild(l);})();</scr` + `ipt>`
  );
}

// Builds { title, payload } for one HTML file: payload = head stylesheet
// links (as @import), head <style> blocks (verbatim, including tags), then
// the <body> inner content.
function buildPayload(raw, file) {
  // Bundled pages: deploy the reconstructed original document instead of the
  // 4.3MB bundle. The page <title> stays on the outer document, so read it
  // from `raw` in both cases.
  const unbundled = unbundle(raw, file);
  const doc = unbundled ?? raw;
  const head = extractTag(doc, "head");
  let body = extractTag(doc, "body");
  if (!body) {
    // Fragment fallback: some files may be committed artifact-style (starting
    // with <title>, no html/head/body wrapper). Treat the whole file minus the
    // <title> tag as the body so a fragment never kills the deploy.
    const t = extractTag(doc, "title");
    const inner = t ? doc.slice(0, t.outerStart) + doc.slice(t.outerEnd) : doc;
    console.warn(`  ${file}: no <body> tag — treating file as a fragment (title stripped)`);
    body = { inner: inner.trim() };
  }
  const outerHead = unbundled ? extractTag(raw, "head") : head;
  const title = outerHead ? extractTag(outerHead.inner, "title") : extractTag(raw, "title");
  const titleText = title ? title.inner.trim() : file;
  const styleBlocks = head ? extractAllStyleBlocks(head.inner) : [];
  const hrefs = head ? extractStylesheetHrefs(head.inner) : [];
  const importBlock = hrefs.length
    ? `<style>${hrefs.map((h) => `@import url("${h}");`).join("")}</style>`
    : "";
  // Unbundled docs keep the dc-runtime app <script> in <head>; namo pages
  // have no head, so append those scripts after the body content. The
  // runtime boots on readyState!=="loading", so running late is fine.
  const headScripts = unbundled && head ? extractAllScriptBlocks(head.inner) : [];
  let payload = rewriteInternalLinks(
    `${importBlock}\n${styleBlocks.join("\n")}\n${body.inner}\n${headScripts.join("\n")}\n${faviconScript(raw)}`.trim()
  );
  // namo's update_page_html validator rejects any payload containing a <body>
  // tag. We only ever send body *inner* content, but bundled/simulated pages
  // may carry the literal `<body` inside JS strings. Escape the 'b' as a
  // \\u0062 unicode escape — JS decodes it back to `<body` at runtime, and no
  // real <body> markup exists in the payload to corrupt.
  payload = payload.replaceAll("<body", "<\\u0062ody").replaceAll("<BODY", "<\\u0042ODY");
  return { title: titleText, payload };
}

// --- MCP JSON-RPC client (stateless; no session handshake needed) --------
let rpcId = 1;
async function mcp(name, args) {
  if (!SB_TOKEN || !SB_SITE_ID) {
    throw new Error("SB_TOKEN and SB_SITE_ID are required for SiteBuilder sync.");
  }
  const res = await fetch(SB_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SB_TOKEN}`,
      "X-Site-Id": SB_SITE_ID,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Surface the raw HTTP body verbatim — schema/size-limit failures show up
    // here (e.g. HTML too large, auth rejected, non-JSON error page).
    throw new Error(`${name}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 2000)}`);
  }
  if (json.error) {
    throw new Error(`${name}: ${json.error.message || JSON.stringify(json.error)} (raw: ${JSON.stringify(json).slice(0, 2000)})`);
  }
  return json.result;
}

// --- MCP result unwrapping -------------------------------------------------
// Live schema (confirmed 2026-07-09): tool results arrive MCP-wrapped as
// { content: [{ type: "text", text: "<json or plain text>" }] }. Unwrap the
// text parts and parse JSON when possible.
function unwrapResult(result) {
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function normalizePagesList(result) {
  const unwrapped = unwrapResult(result);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (unwrapped && Array.isArray(unwrapped.pages)) return unwrapped.pages;
  console.warn(`  list_pages: unrecognized result shape, raw: ${JSON.stringify(result).slice(0, 1000)}`);
  return [];
}

function normalizeSlug(s) {
  if (typeof s !== "string") return null;
  let v = s.trim().toLowerCase();
  if (v.startsWith("/")) v = v.slice(1);
  if (v.endsWith(".html")) v = v.slice(0, -".html".length);
  return v;
}

function pageSlugCandidates(page) {
  return [page.slug, page.path, page.url, page.name].map(normalizeSlug).filter((v) => v !== null);
}

function pageTitle(page) {
  return typeof page.title === "string" ? page.title.trim() : typeof page.name === "string" ? page.name.trim() : null;
}

function pageId(page) {
  return page.id ?? page.pageId ?? page._id ?? page.page_id ?? null;
}

function findMatch(pages, slugCandidates, title) {
  const wanted = new Set(slugCandidates.map(normalizeSlug));
  for (const page of pages) {
    for (const cand of pageSlugCandidates(page)) {
      if (wanted.has(cand)) return page;
    }
  }
  for (const page of pages) {
    const t = pageTitle(page);
    if (t && t === title) return page;
  }
  return null;
}

// --- run --------------------------------------------------------------------
async function main() {
  const targets = [];
  for (const p of PAGES) {
    if (!isTargeted(p.file)) continue;
    const raw = await readFile(path.join(root, p.file), "utf8");
    const { title, payload } = buildPayload(raw, p.file);
    targets.push({ ...p, title, payload });
  }

  console.log(`Deploy: ${ALL ? "ALL pages" : [...changedSet].join(", ") || "(none changed)"}`);

  if (!targets.length) {
    console.log("Nothing to do (no targeted *.html files).");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDRY_RUN plan (no API calls made):");
    for (const t of targets) {
      const bytes = Buffer.byteLength(t.payload, "utf8");
      console.log(
        `  ${t.file.padEnd(20)} -> slug="${t.slug}"${t.slugAliases.length ? ` (aliases: ${t.slugAliases.map((a) => (a === "" ? "(empty)" : a)).join(",")})` : ""}` +
          ` title="${t.title}" action=list_pages→match-or-create→update_page_html bytes=${bytes}`
      );
    }
    console.log(`\nTotal payload: ${Buffer.byteLength(targets.map((t) => t.payload).join(""), "utf8")} bytes across ${targets.length} page(s).`);
    return;
  }

  console.log("Fetching list_pages...");
  const pagesResult = await mcp("list_pages", {});
  const pages = normalizePagesList(pagesResult);
  console.log(`  found ${pages.length} existing page(s)`);

  const summary = [];
  for (const t of targets) {
    console.log(`\n${t.file}:`);
    const slugCandidates = [t.slug, ...t.slugAliases];
    let match = findMatch(pages, slugCandidates, t.title);
    let id;
    if (match) {
      id = pageId(match);
      if (id === null) {
        console.error(`  matched a remote page by slug/title but could not read its id. raw: ${JSON.stringify(match).slice(0, 1000)}`);
        summary.push(`${t.file}: FAILED (no id on matched page)`);
        continue;
      }
      console.log(`  matched existing page id=${id} (slug/title match)`);
    } else {
      // Live schema: create_page takes `path` (e.g. "/landing"), not `slug`.
      const pagePath = t.slug === "index" ? "/" : `/${t.slug}`;
      console.log(`  no match found — creating page (title="${t.title}", path="${pagePath}")`);
      try {
        const created = unwrapResult(await mcp("create_page", { title: t.title, path: pagePath, inMenu: true }));
        // Live behavior (confirmed): page creation itself enters the admin
        // approval queue — the response is a plain-text "Pending approval..."
        // notice, not a page object. Treat that as submitted, not failed:
        // once approved, the next run matches the page via list_pages and
        // pushes the HTML.
        if (typeof created === "string" && created.includes("Pending approval")) {
          console.log(`  create_page submitted for admin approval — HTML will be pushed on the next run after approval.`);
          summary.push(`${t.file}: page creation awaiting admin approval (approve in namo admin UI, then re-run)`);
          continue;
        }
        id = pageId(created) ?? pageId(created?.page ?? {});
        if (id === null) {
          console.error(`  create_page succeeded but response had no recognizable id. raw: ${JSON.stringify(created).slice(0, 1000)}`);
          summary.push(`${t.file}: FAILED (create_page: no id in response)`);
          continue;
        }
        console.log(`  created page id=${id}`);
      } catch (e) {
        console.error(`  create_page FAILED: ${e.message}`);
        summary.push(`${t.file}: FAILED (create_page error)`);
        continue;
      }
    }

    // Stateless sync: read the remote page's stored HTML and skip identical
    // content. This makes every run converge repo state → site state, so a
    // cancelled/failed earlier run can never permanently lose a change, and
    // unchanged pages don't spam the approval queue.
    try {
      const remote = unwrapResult(await mcp("read_page", { pageId: id }));
      const remoteHtml = typeof remote === "object" && remote !== null && typeof remote.html === "string" ? remote.html : null;
      if (remoteHtml !== null && remoteHtml.trim() === t.payload.trim()) {
        console.log(`  remote content identical — skipping`);
        summary.push(`${t.file}: unchanged (skipped)`);
        continue;
      }
    } catch (e) {
      console.warn(`  read_page failed (${e.message.slice(0, 200)}) — submitting anyway`);
    }

    try {
      await mcp("update_page_html", { pageId: id, html: t.payload });
      const bytes = Buffer.byteLength(t.payload, "utf8");
      console.log(`  update_page_html submitted (${bytes} bytes, pending admin approval)`);
      summary.push(`${t.file}: submitted (${bytes} bytes) -> page ${id}`);
    } catch (e) {
      console.error(`  update_page_html FAILED: ${e.message}`);
      summary.push(`${t.file}: FAILED (update_page_html error)`);
    }
  }

  console.log("\nSummary:");
  for (const line of summary) console.log(`  ${line}`);

  if (summary.some((s) => s.includes("FAILED"))) {
    process.exitCode = 1;
  } else {
    console.log("\nNote: HTML changes await admin approval before going live on namo.site.");
  }
}

await main();
