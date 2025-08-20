// api/client-data.js (CommonJS)

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  console.log("=== API HANDLER START ===");

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;
    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res
        .status(500)
        .json({ error: "Server configuration error - missing environment variables" });
    }

    // ---- Query params
    const {
      userEmail = null, // optional now, kept for logging
      secureKey,
      timestamp,
      client: clientParam,
      // perf switches
      fast = "1", // ?fast=1 disables relation walk (default on)
      maxPages = "10", // pagination safety
      pageSize = "100", // Notion page_size
    } = req.query || {};

    if (!secureKey || !timestamp) {
      return res
        .status(401)
        .json({ error: "Missing authentication parameters" });
    }

    // ---- Auth
    const { ok, isAdmin, clientFromKey } = verifySecureKey(secureKey, timestamp);
    if (!ok) return res.status(401).json({ error: "Invalid access credentials" });

    // Which client are we allowed to load?
    let clientName = null;
    const clean = (s) => (s || "").trim();

    if (!clientFromKey) {
      return res.status(401).json({ error: "Key not recognized" });
    }

    if (clean(clientParam)) {
      if (clean(clientParam) !== clientFromKey) {
        return res.status(403).json({ error: "Client/key mismatch" });
      }
      clientName = clean(clientParam);
    } else {
      clientName = clientFromKey;
    }

    console.log("Resolved ⇒ isAdmin:", isAdmin, "| clientName:", clientName);

    // ==== Notion fetch helpers (timeouts, retry-light) ====
    const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        return res;
      } finally {
        clearTimeout(id);
      }
    };

    const notionHeaders = {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    // ==== Pagination (always filtered by Client) ====
    const safePageSize = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 100));
    const safeMaxPages = Math.max(1, Math.min(25, parseInt(maxPages, 10) || 10));

    const baseRequestBody = {
      page_size: safePageSize,
      filter: { property: "Client", select: { equals: clientName } },
    };

    let allResults = [];
    let hasMore = true;
    let nextCursor = null;
    let pageCount = 0;

    while (hasMore && pageCount < safeMaxPages) {
      pageCount++;
      const requestBody = { ...baseRequestBody };
      if (nextCursor) requestBody.start_cursor = nextCursor;

      console.log(
        `[Notion] Query page ${pageCount}/${safeMaxPages} | start_cursor=${
          nextCursor || "∅"
        }`
      );

      const resp = await fetchWithTimeout(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
          method: "POST",
          headers: notionHeaders,
          body: JSON.stringify(requestBody),
        },
        15000
      );

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return res.status(500).json({
          error: `Notion API error on page ${pageCount}: ${resp.status}`,
          details: text,
        });
      }

      const data = await resp.json();
      const results = data.results || [];
      allResults = allResults.concat(results);
      hasMore = !!data.has_more;
      nextCursor = data.next_cursor || null;

      console.log(
        `[Notion] Page ${pageCount} → +${results.length} (total ${
          allResults.length
        }) | has_more=${hasMore}`
      );
    }

    // ==== Optional/whitelisted relation resolution (cached, capped) ====
    const doRelations = fast !== "1"; // default OFF unless fast=0
    const RELATION_WHITELIST = new Set([
      "Vendor1",
      "Vendor",
      "Vendor Name",
      "Vendor/Label",
    ]);
    const RELATION_CAP = 150; // hard cap to avoid long tail
    const relationCache = new Map(); // pageId -> title

    if (doRelations && allResults.length) {
      console.log(
        `[Relations] Resolving enabled (whitelist ${RELATION_WHITELIST.size} keys, cap=${RELATION_CAP})`
      );

      let hits = 0;
      for (let i = 0; i < allResults.length; i++) {
        const rec = allResults[i];
        const props = rec.properties || {};
        for (const [key, prop] of Object.entries(props)) {
          if (hits >= RELATION_CAP) break;
          if (!RELATION_WHITELIST.has(key)) continue;
          if (prop?.type !== "relation") continue;
          if (!Array.isArray(prop.relation) || !prop.relation.length) continue;

          const firstId = prop.relation[0]?.id;
          if (!firstId) continue;

          // cached?
          if (relationCache.has(firstId)) {
            props[key].relation_titles = relationCache.get(firstId);
            continue;
          }

          try {
            hits++;
            const pageResp = await fetchWithTimeout(
              `https://api.notion.com/v1/pages/${firstId}`,
              { headers: notionHeaders },
              12000
            );

            if (pageResp.ok) {
              const relPage = await pageResp.json();
              const titleProp = Object.values(relPage.properties || {}).find(
                (p) => p.type === "title"
              );
              const title = titleProp?.title?.[0]?.plain_text || "";
              if (title) {
                relationCache.set(firstId, title);
                props[key].relation_titles = title;
              }
            }
            // small breather to avoid bursts
            if (hits % 8 === 0) await sleep(80);
          } catch (e) {
            console.error(
              `Relation fetch error for ${key}:`,
              e && e.message ? e.message : e
            );
          }
        }
        if (hits >= RELATION_CAP) break;
      }
      console.log(
        `[Relations] Resolved count: ${hits} | cache size: ${relationCache.size}`
      );
    } else {
      console.log("[Relations] Skipped (fast=1 or no results).");
    }

    // ==== Column config & metadata
    const columnConfig = getUniversalColumnConfig();

    const respPayload = {
      results: allResults,
      authorizedClient: clientName,
      userEmail, // optional, for logging
      isAdmin, // always false in key-only mode
      columnOrder: columnConfig.columns,
      columnHeaders: columnConfig.columnHeaders,
      debug: {
        recordCount: allResults.length,
        pagesFetched: pageCount,
        fastMode: fast === "1",
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - t0,
      },
      metadata: {
        incomeTypes: uniq(
          allResults.map((r) => r?.properties?.["Income Type"]?.select?.name)
        ),
        currencies: uniq(
          allResults.map(
            (r) =>
              r?.properties?.["Currency (Inv/Stmt)"]?.select?.name ||
              r?.properties?.["Currency"]?.select?.name
          )
        ),
        receiptCurrencies: uniq(
          allResults.map(
            (r) => r?.properties?.["Currency (receipt)"]?.select?.name
          )
        ),
      },
    };

    console.log(
      `=== API HANDLER SUCCESS (${respPayload.debug.recordCount} rows in ${respPayload.debug.durationMs}ms) ===`
    );
    return res.status(200).json(respPayload);
  } catch (error) {
    console.error("=== API HANDLER ERROR ===", error?.message || error);
    return res.status(500).json({
      error: `Server error: ${error?.message || "unknown"}`,
      type: error?.constructor?.name,
      stack: error?.stack,
      timestamp: new Date().toISOString(),
    });
  }
};

/* ----------------- Helpers ----------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function getUniversalColumnConfig() {
  return {
    columns: [
      "Invoice date",
      "Inv #",
      "Vendor1",
      "Description",
      "Income Type",
      "Net",
      "Gross",
      "Currency",
      "Paid in Date",
      "Amount Received",
      "Currency (receipt)",
      "Adjustments",
      "Net Commissionable",
      "Commission %",
      "Mgmt Commission",
      "Mgmt Inv #",
    ],
    columnHeaders: {
      "Invoice date": "Date",
      "Inv #": "Inv #",
      Vendor1: "Vendor",
      Description: "Description",
      "Income Type": "Income Type",
      Net: "Net",
      Gross: "Gross",
      Currency: "Currency (Inv/Stmt)",
      "Paid in date": "Paid in Date",
      "Amount Received": "Amount Received",
      "Currency (receipt)": "Currency (Received)",
      Adjustments: "Adjustments",
      "Net Commissionable": "Net Commissionable",
      "Commission %": "Commission %",
      "Mgmt Commission": "Commission",
      "Mgmt Inv #": "Mgmt Inv #",
    },
  };
}

/**
 * verifySecureKey
 *  - secureKey must match a known client key
 *  - timestamp must be within ±1h
 * Returns { ok, isAdmin, clientFromKey }
 */
function verifySecureKey(secureKey, timestamp) {
  try {
    const makeKey = (prefix, seed) =>
      prefix +
      Buffer.from(seed)
        .toString("base64")
        .replace(/[^a-zA-Z0-9]/g, "");

    const CLIENT_KEY_DEFS = {
      "King Ed": { prefix: "ke-", seeds: ["king-ed-2025"] },
      "Linden Jay": { prefix: "lj-", seeds: ["linden-jay-2025", "client-a-2024"] },
      "Will Vaughan": { prefix: "wv-", seeds: ["will-vaughan-2025", "client-a-2024"] },
      Tiggs: { prefix: "nf-", seeds: ["tiggs-2025", "client-a-2024"] },
      'Kieran "KES" Beardmore': {
        prefix: "kb-",
        seeds: ["kieran-beardmore-2025", "client-b-2024"],
      },
    };

    const clientToKeys = {};
    for (const [client, def] of Object.entries(CLIENT_KEY_DEFS)) {
      clientToKeys[client] = new Set(
        def.seeds.map((seed) => makeKey(def.prefix, seed))
      );
    }

    // timestamp window
    const now = Math.floor(Date.now() / 1000);
    const reqTs = parseInt(timestamp, 10);
    const drift = now - reqTs;
    if (Number.isNaN(reqTs) || drift > 3600 || drift < -300) {
      return { ok: false, isAdmin: false, clientFromKey: null };
    }

    // reverse lookup: which client does this key belong to?
    let clientFromKey = null;
    for (const [client, keys] of Object.entries(clientToKeys)) {
      if (keys.has(secureKey)) {
        clientFromKey = client;
        break;
      }
    }

    return { ok: !!clientFromKey, isAdmin: false, clientFromKey };
  } catch (e) {
    console.error("Secure key verification error:", e?.message || e);
    return { ok: false, isAdmin: false, clientFromKey: null };
  }
}
