// Deploy officemate's static HTML pages to namo.site (SiteBuilder) on git push.
//
// Unlike the portfolio repo (single page, CDN-backed assets), officemate is:
//   - all-in-one HTML files (head: title/meta/style, body: markup+script) — no
//     separate css/js tracked by a CDN, so there is no purge track here.
//   - multi-page: 6 root HTML files, each mapped to one namo page.
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

const SB_URL = process.env.SB_URL || "https://asia-northeast3-sunbisites.cloudfunctions.net/mcp_code_server";
const SB_TOKEN = process.env.SB_TOKEN || "";
const SB_SITE_ID = process.env.SB_SITE_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1";

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

// Builds { title, payload } for one HTML file: payload = head <style> blocks
// (verbatim, including tags) concatenated, then the <body> inner content.
function buildPayload(raw, file) {
  const head = extractTag(raw, "head");
  const body = extractTag(raw, "body");
  if (!body) throw new Error(`${file}: <body> not found`);
  const title = head ? extractTag(head.inner, "title") : extractTag(raw, "title");
  const titleText = title ? title.inner.trim() : file;
  const styleBlocks = head ? extractAllStyleBlocks(head.inner) : [];
  const payload = `${styleBlocks.join("\n")}\n${body.inner}`.trim();
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

// --- list_pages result normalization --------------------------------------
// Schema is not confirmed against a live call (no token available while
// authoring this script) — normalize defensively over the field-name
// variants seen in comparable MCP tools, and log the raw shape on mismatch
// so a real run's error output can be used to correct this.
function normalizePagesList(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.pages)) return result.pages;
  if (result && Array.isArray(result.items)) return result.items;
  if (result && Array.isArray(result.data)) return result.data;
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
      console.log(`  no match found — creating page (title="${t.title}", slug="${t.slug}")`);
      try {
        const created = await mcp("create_page", { title: t.title, slug: t.slug });
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
