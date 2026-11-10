// ==UserScript==
// @name         Amazon: undelivered items by day
// @namespace    stefan.scripts
// @version      1.7.0
// @description  On Your Orders, lists every item not delivered yet by arrival day, plus what was delivered today.
// @match        https://www.amazon.com/your-orders/orders*
// @match        https://www.amazon.com/gp/css/order-history*
// @match        https://www.amazon.com/gp/your-account/order-history*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  const MAX_PAGES = 5;
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const CACHE_ROOT = 'amazon-undelivered:page:';
  // Bump when parsing changes so pages cached by an older parser are refetched.
  const CACHE_PREFIX = `${CACHE_ROOT}v4:`;
  const RELATIVE_DAY = /\b(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
  const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/g;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  // Headings inside an order that aren't shipment statuses (e.g. a "Buy it again" carousel) must not swallow product links.
  const STATUS_WORDS = /arriv|ship|deliver|transit|prepar|expect|late|delay|out for|pick ?up|not yet|package|cancel|refund|return/i;
  const PRODUCT_HREF = /\/(dp|gp\/product)\//;
  const AD_HREF = /\/sspa\/|\/gp\/r\.html|aax-|amazon-adsystem/;
  const ASIN = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})|[?&]asin=([A-Z0-9]{10})/i;
  const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b|\bnoon\b/i;
  // Leaf text under a shipment that isn't a control or hidden popover content, e.g. "Your package was left in the mail room."
  const NOT_NOTE = 'a, button, [role="button"], .a-button, .a-hidden, [hidden], [aria-hidden="true"], script, style, noscript, template';

  const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const isHeading = (el) => /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading';

  // Amazon's class names churn, so this walks the page in document order the way the accessibility tree reads it:
  // an "ORDER PLACED …" heading starts an order, each later heading is a shipment status, and product links after it are that shipment's items.
  function parseOrdersPage(doc) {
    const shipments = [];
    let order = null;
    let orderHeader = null;
    let shipment = null;
    let statusHeading = null;
    let lastProduct = null;

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.classList.contains('a-pagination')) break;

      if (isHeading(el)) {
        if (orderHeader?.contains(el) || statusHeading?.contains(el)) continue;
        const text = norm(el.textContent);
        if (/^order placed\b/i.test(text)) {
          order = parseOrderHeader(text);
          // The heading's text also holds the hidden address popover, so the name comes from the ship-to link alone.
          const shipTo = [...el.querySelectorAll('a')].map((a) => norm(a.textContent)).find((t) => t && !/^view\b/i.test(t));
          if (shipTo) order.shipTo = shipTo;
          orderHeader = el;
          shipment = null;
          statusHeading = null;
        } else if (order && text.length < 120 && STATUS_WORDS.test(text)) {
          shipment = { status: text, notes: [], products: new Map(), order };
          statusHeading = el;
          shipments.push(shipment);
        } else {
          shipment = null;
          statusHeading = null;
        }
        lastProduct = null;
        continue;
      }

      if (shipment && el.childElementCount === 0 && !statusHeading.contains(el) && !el.closest(NOT_NOTE)) {
        const note = norm(el.textContent);
        // Grocery orders show quantity as a bare number badge right after the item's image link.
        if (/^\d+$/.test(note) && lastProduct) lastProduct.quantity = Number(note);
        else if (note && note.length <= 200 && !shipment.notes.includes(note)) shipment.notes.push(note);
      }

      if (el.tagName !== 'A' || !order) continue;
      const text = norm(el.textContent);
      const href = el.getAttribute('href') ?? '';
      if (/^view order details$/i.test(text)) {
        order.detailsUrl = new URL(href, location.origin).href;
        continue;
      }
      if (!shipment || AD_HREF.test(href)) continue;
      const img = el.querySelector('img');
      const alt = norm(img?.getAttribute('alt'));
      if (!PRODUCT_HREF.test(href) && !alt) continue;
      const asin = href.match(ASIN)?.slice(1).find(Boolean) ?? '';
      const productId = asin || href;
      // Most products render as an image link followed by a title link to the same product;
      // grocery items are a lone image link whose only name is the image's alt text.
      const product = shipment.products.get(productId) ?? { title: '', fallbackTitle: '', image: '', asin, quantity: 1 };
      if (!/^\d*$/.test(text)) product.title ||= text;
      product.fallbackTitle ||= alt || norm(el.getAttribute('aria-label') ?? el.getAttribute('title'));
      product.image ||= imageSrc(img);
      shipment.products.set(productId, product);
      lastProduct = product;
    }

    return {
      shipments: shipments
        .map(({ products, ...rest }) => ({ ...rest, items: [...products.values()].map(({ fallbackTitle, ...p }) => ({ ...p, title: p.title || fallbackTitle, imageOnly: !p.title })).filter((p) => p.title) }))
        .filter((s) => s.items.length > 0),
      nextUrl: findNextUrl(doc),
    };
  }

  // The header reads "ORDER PLACED November 9, 2026 TOTAL $43.29 SHIP TO Stefan Mirea ORDER # 111-… View order details …";
  // cancelled orders omit TOTAL and SHIP TO.
  function parseOrderHeader(text) {
    const field = (re) => text.match(re)?.[1] ?? '';
    return {
      detailsUrl: null,
      placed: field(/order placed\s+(.+?)(?=\s+(?:total|ship to|order #)|$)/i),
      total: field(/\btotal\s+(\S+)/i),
      shipTo: field(/ship to\s+(.+?)(?=\s+order #|$)/i),
      number: field(/order #\s*([\d-]+)/i),
    };
  }

  function imageSrc(img) {
    if (!img) return '';
    const src = img.getAttribute('src') ?? '';
    return src.startsWith('data:') ? (img.getAttribute('data-src') ?? '') : src;
  }

  function findNextUrl(doc) {
    const next = [...doc.querySelectorAll('a')].find((a) => /^next\b/i.test(norm(a.textContent)));
    const href = next?.getAttribute('href');
    if (!href || href === '#' || next.closest('.a-disabled')) return null;
    return new URL(href, location.origin).href;
  }

  const isDelivered = (status) => /^delivered\b/i.test(status);
  const isClosed = (status) => /cancel|refund|return/i.test(status);
  const isPending = (status) => !isDelivered(status) && !isClosed(status);

  const startOfToday = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  };
  const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const dayDiff = (a, b) => Math.round((a - b) / 864e5);

  function dateFromMonthDay(monthName, day, today) {
    const date = new Date(today.getFullYear(), MONTHS.indexOf(monthName), Number(day));
    const diff = dayDiff(date, today);
    if (diff < -180) return addYears(date, 1);
    if (diff > 180) return addYears(date, -1);
    return date;
  }
  const addYears = (date, n) => new Date(date.getFullYear() + n, date.getMonth(), date.getDate());

  // Returns { start, end } or null when the status names no day ("Shipped", "Preparing for shipment").
  function arrivalRange(status, today) {
    const s = status.toLowerCase();
    if (/\btoday\b|out for delivery/.test(s)) return { start: today, end: today };
    if (/\btomorrow\b/.test(s)) return { start: addDays(today, 1), end: addDays(today, 1) };
    const dates = [...s.matchAll(MONTH_DAY)].map((m) => dateFromMonthDay(m[1], m[2], today));
    if (dates.length > 0) return { start: dates[0], end: dates.at(-1) };
    const weekday = WEEKDAYS.findIndex((d) => s.includes(d));
    if (weekday >= 0) {
      const date = addDays(today, (weekday - today.getDay() + 7) % 7 || 7);
      return { start: date, end: date };
    }
    // Same-day deliveries read "Delivered 1:05 PM" with no date.
    if (/^delivered\b/.test(s) && CLOCK.test(s)) return { start: today, end: today };
    return null;
  }

  const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fromIso = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const toIsoRange = (range) => range && { start: toIso(range.start), end: toIso(range.end) };
  const fromIsoRange = (range) => range && { start: fromIso(range.start), end: fromIso(range.end) };

  const isDeliveredToday = (shipment, today) => {
    const arrival = isDelivered(shipment.status) && fromIsoRange(shipment.arrival);
    return Boolean(arrival) && dayDiff(arrival.start, today) === 0;
  };

  // Today first, then upcoming days, then late and undated shipments at the bottom.
  function groupRank(range, today) {
    if (!range) return [3, 0, 0];
    const startDiff = dayDiff(range.start, today);
    return [startDiff < 0 ? 2 : 1, startDiff, dayDiff(range.end, today)];
  }

  // Minutes after midnight of the first clock time in the status ("11 AM – 2 PM" -> 660); untimed statuses sort last.
  function clockMinutes(status) {
    const m = status.match(CLOCK);
    if (!m) return 24 * 60;
    if (!m[1]) return 12 * 60;
    return ((Number(m[1]) % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(m[2] ?? 0);
  }

  // Returns arrays of { item, shipment }, one per arrival day, in display order.
  function groupByDay(shipments, today) {
    const groups = new Map();
    for (const shipment of shipments) {
      const rank = groupRank(fromIsoRange(shipment.arrival), today);
      const key = rank.join('|');
      if (!groups.has(key)) groups.set(key, { rank, rows: [] });
      groups.get(key).rows.push(...shipment.items.map((item) => ({ item, shipment })));
    }
    return [...groups.values()]
      .toSorted((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
      .map((group) => group.rows.toSorted((a, b) => clockMinutes(a.shipment.status) - clockMinutes(b.shipment.status)));
  }

  function shortTitle(title) {
    const cut = title.slice(15).search(/ [|\-–—] |, | \(/);
    const base = cut >= 0 ? title.slice(0, cut + 15) : title;
    return base.length > 60 ? `${base.slice(0, 57).trimEnd()}…` : base;
  }

  function firstPageUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('page');
    url.searchParams.delete('startIndex');
    return url;
  }

  function isOnFirstPage() {
    const params = new URL(location.href).searchParams;
    return (params.get('page') ?? '1') === '1' && (params.get('startIndex') ?? '0') === '0';
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function assertUsable(doc, url) {
    if (/\/ap\/signin/.test(url)) throw new Error('Amazon redirected to sign-in. Sign in again, then reload this page.');
    if (/\/checkpoint\/|validateCaptcha/.test(url) || /\bi am human\b/i.test(doc.body?.textContent ?? '')) {
      throw new Error(`Amazon wants a human check. Open ${url}, tick the box, then click ↻ here.`);
    }
  }

  async function loadPage(url) {
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`Fetching ${url} failed with HTTP ${res.status}. Reload the page and try again.`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    assertUsable(doc, res.url);
    const page = parseOrdersPage(doc);
    return page.shipments.length > 0 ? page : loadPageInFrame(url);
  }

  // Fallback for when the fetched HTML is a shell that renders orders client-side: a hidden iframe runs Amazon's scripts.
  async function loadPageInFrame(url) {
    const frame = h('iframe', { src: url, title: 'amazon-undelivered scan' });
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:900px;visibility:hidden';
    document.body.append(frame);
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await sleep(300);
        const doc = frame.contentDocument;
        if (!doc?.body || doc.URL === 'about:blank') continue;
        assertUsable(doc, doc.URL);
        const page = parseOrdersPage(doc);
        if (page.shipments.length > 0 && doc.readyState === 'complete') return page;
      }
      return { shipments: [], nextUrl: null };
    } finally {
      frame.remove();
    }
  }

  function cacheKey(pageNumber) {
    const url = firstPageUrl();
    url.searchParams.delete('ref_');
    url.searchParams.delete('ref');
    url.searchParams.sort();
    return `${CACHE_PREFIX}${url.pathname}?${url.searchParams}#${pageNumber}`;
  }

  // Cache failures (private mode, quota, corrupt JSON) only cost a refetch, so they never break the scan.
  function readCache(key) {
    try {
      const entry = JSON.parse(localStorage.getItem(key) ?? 'null');
      return entry && Date.now() - entry.savedAt < CACHE_TTL_MS ? entry : null;
    } catch {
      return null;
    }
  }

  function writeCache(key, page, after) {
    try {
      for (const stale of Object.keys(localStorage)) {
        if (stale.startsWith(CACHE_ROOT) && (!stale.startsWith(CACHE_PREFIX) || !readCache(stale))) localStorage.removeItem(stale);
      }
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), after, page }));
    } catch (error) {
      console.warn('[amazon-undelivered] could not cache page', error);
    }
  }

  const hasDueToday = (page, today) =>
    page.shipments.some((s) => isPending(s.status) && s.arrival && dayDiff(fromIso(s.arrival.start), today) <= 0);

  const orderKey = (shipment) => shipment.order.number || shipment.order.detailsUrl || shipment.items.map((i) => i.title).join('|');

  // Arrival days are resolved when a page is scraped, so a cached "Arriving tomorrow" still lands on the right day later.
  async function scrapePage(pageNumber, url, today) {
    const page = pageNumber === 1 && isOnFirstPage() ? parseOrdersPage(document) : await loadPage(url);
    if (page.shipments.length === 0) {
      throw new Error(`Found no orders on page ${pageNumber}. Amazon's page layout may have changed; update parseOrdersPage in src/tampermonkey/amazon-undelivered.user.js.`);
    }
    const scrapedAt = Date.now();
    const shipments = page.shipments.map((s) => ({ ...s, pageNumber, scrapedAt, arrival: toIsoRange(arrivalRange(s.status, today)) }));
    return { shipments, nextUrl: page.nextUrl };
  }

  // Scans pages until one has nothing left to deliver, since anything older than that page is delivered too.
  // Yields after every page so the panel can show results while later pages load. Page 1 is always live.
  async function* scanPending(today, useCache) {
    let url = firstPageUrl().href;
    const seenOrders = new Set();
    let previousLast = null;
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const key = cacheKey(pageNumber);
      const entry = pageNumber > 1 && useCache ? readCache(key) : null;
      // New orders shift every later page, so a cached page is only the same slice of orders while the order before it
      // hasn't changed. Pages with something due today are refetched so deliveries show up as they happen.
      const cached = entry?.after === previousLast && !hasDueToday(entry.page, today) ? entry : null;
      const page = cached?.page ?? (await scrapePage(pageNumber, url, today));
      if (pageNumber > 1 && !cached) writeCache(key, page, previousLast);
      previousLast = orderKey(page.shipments.at(-1));

      // Orders can also shift between Amazon's page loads, so a page may repeat orders an earlier page already listed.
      const shipments = page.shipments.filter((s) => !seenOrders.has(orderKey(s)));
      for (const s of page.shipments) seenOrders.add(orderKey(s));

      const pending = shipments.filter((s) => isPending(s.status));
      const deliveredToday = shipments.filter((s) => isDeliveredToday(s, today));
      let stopReason = null;
      if (!page.shipments.some((s) => isPending(s.status))) stopReason = `page ${pageNumber} is all delivered`;
      else if (!page.nextUrl) stopReason = `page ${pageNumber} is the last page`;
      else if (pageNumber === MAX_PAGES) stopReason = `hit the ${MAX_PAGES}-page limit`;
      yield { pageNumber, pending, deliveredToday, stopReason, cached: Boolean(cached) };
      if (stopReason) return;
      url = page.nextUrl;
    }
  }

  const CSS = `
    #aud-panel { position: fixed; top: 110px; left: 16px; z-index: 9999; width: min(360px, calc(100vw - 32px));
      max-height: calc(100vh - 130px); overflow: auto; background: #fff; color: #0f1111; border: 1px solid #d5d9d9;
      border-radius: 8px; box-shadow: 0 4px 16px rgba(15,17,17,.15); font: 13px/1.4 "Amazon Ember", Arial, sans-serif; }
    #aud-panel header { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: #f0f2f2; border-bottom: 1px solid #d5d9d9; font-weight: 700; }
    #aud-panel header span { flex: 1; }
    #aud-panel header button { border: 0; background: none; cursor: pointer; font-size: 15px; color: #565959; padding: 0 2px; }
    #aud-panel header button:hover { color: #0f1111; }
    #aud-panel .aud-body { padding: 4px 12px 10px; }
    #aud-panel hr { margin: 6px -12px; border: 0; border-top: 1px solid #d5d9d9; }
    #aud-panel .aud-grid { display: grid; grid-template-columns: repeat(auto-fill, 44px); gap: 6px; padding: 6px 0; }
    #aud-panel .aud-grid a { position: relative; display: block; line-height: 0; }
    #aud-panel .aud-qty { position: absolute; right: -3px; bottom: -3px; padding: 0 4px; background: #fff; border: 1px solid #d5d9d9;
      border-radius: 8px; font-size: 10px; font-weight: 700; line-height: 14px; color: #0f1111; }
    #aud-panel .aud-caption { margin-bottom: -4px; text-align: right; color: #8a8f8f; font-size: 11px; line-height: 1.2; }
    #aud-panel .aud-grid img, #aud-panel .aud-grid .aud-noimg { width: 44px; height: 44px; object-fit: contain; border-radius: 4px; background: #f7f7f7; }
    #aud-panel .aud-row { display: flex; gap: 10px; align-items: center; padding: 4px 0; color: #0f1111; text-decoration: none; }
    #aud-panel .aud-row:hover .aud-name { color: #c7511f; text-decoration: underline; }
    #aud-panel .aud-row img, #aud-panel .aud-noimg { flex: none; width: 44px; height: 44px; object-fit: contain; border-radius: 4px; background: #f7f7f7; }
    #aud-panel .aud-text { min-width: 0; }
    #aud-panel .aud-eta { font-weight: 700; font-size: 12px; color: #007600; }
    #aud-panel .aud-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #aud-panel .aud-status { color: #565959; font-size: 12px; }
    #aud-panel .aud-note { color: #565959; font-size: 12px; margin-top: 10px; }
    #aud-panel .aud-error { color: #b12704; }
    #aud-tip { position: fixed; z-index: 10000; display: none; width: 280px; padding: 12px; background: #fff; color: #0f1111;
      border: 1px solid #d5d9d9; border-radius: 8px; box-shadow: 0 4px 16px rgba(15,17,17,.2);
      font: 12px/1.4 "Amazon Ember", Arial, sans-serif; pointer-events: none; }
    #aud-tip * { box-sizing: border-box; margin: 0; padding: 0; float: none; }
    #aud-tip .aud-tip-title { font-weight: 700; font-size: 13px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3;
      -webkit-box-orient: vertical; overflow: hidden; }
    #aud-tip .aud-tip-status { margin-top: 2px; font-weight: 700; color: #007600; }
    #aud-tip .aud-tip-note { margin-top: 2px; color: #565959; }
    #aud-tip .aud-tip-fields { display: grid; grid-template-columns: 64px 1fr; gap: 3px 10px; margin-top: 10px; padding-top: 10px;
      border-top: 1px solid #e7e9e9; }
    #aud-tip .aud-tip-label { color: #565959; }
    #aud-tip .aud-tip-value { min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    #aud-tip .aud-tip-footer { margin-top: 10px; color: #8a8f8f; font-size: 11px; }
  `;

  function h(tag, props = {}, children = []) {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...children);
    return el;
  }

  function mountPanel() {
    document.getElementById('aud-panel')?.remove();
    if (!document.getElementById('aud-style')) document.head.append(h('style', { id: 'aud-style', textContent: CSS }));
    const title = h('span', { textContent: 'Not delivered yet' });
    const refresh = h('button', { title: 'Rescan all pages, ignoring the cache', textContent: '↻', onclick: () => run({ useCache: false }) });
    const close = h('button', { title: 'Close', textContent: '×', onclick: () => { hideTooltip(); panel.remove(); } });
    const body = h('div', { className: 'aud-body' });
    const panel = h('section', { id: 'aud-panel' }, [h('header', {}, [title, refresh, close]), body]);
    document.body.append(panel);
    return { title, body };
  }

  function relativeDay(date, today) {
    const diff = dayDiff(date, today);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff > 1 && diff < 7) return fmtDate(date, { weekday: 'long' });
    return fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const fmtDate = (date, opts) => date.toLocaleDateString('en-US', opts);

  // "Arriving tomorrow" -> "Tomorrow". Relative days are recomputed from the scraped date, since a cached
  // "tomorrow" may already be today.
  function etaText(shipment, today) {
    let eta = shipment.status.replace(/^((now )?arriving|estimated to arrive)\s+/i, '');
    const arrival = fromIsoRange(shipment.arrival);
    if (arrival && dayDiff(arrival.start, arrival.end) === 0) eta = eta.replace(RELATIVE_DAY, relativeDay(arrival.start, today));
    return eta.charAt(0).toUpperCase() + eta.slice(1);
  }

  function timeAgo(ms) {
    const minutes = Math.round((Date.now() - ms) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
  }

  function tooltip() {
    return document.getElementById('aud-tip') ?? document.body.appendChild(h('div', { id: 'aud-tip' }));
  }

  function showTooltip(anchor, { item, shipment }) {
    const { order } = shipment;
    const fields = [
      ['Order #', order.number],
      ['Placed', order.placed],
      ['Total', order.total],
      ['Ship to', order.shipTo],
      ['Quantity', item.quantity > 1 ? String(item.quantity) : ''],
      ['ASIN', item.asin],
    ].filter(([, value]) => value);
    const tip = tooltip();
    tip.replaceChildren(
      h('div', { className: 'aud-tip-title', textContent: item.title }),
      h('div', { className: 'aud-tip-status', textContent: shipment.status }),
      ...shipment.notes.map((note) => h('div', { className: 'aud-tip-note', textContent: note })),
      h('div', { className: 'aud-tip-fields' }, fields.flatMap(([label, value]) => [
        h('div', { className: 'aud-tip-label', textContent: label }),
        h('div', { className: 'aud-tip-value', textContent: value }),
      ])),
      h('div', { className: 'aud-tip-footer', textContent: `Page ${shipment.pageNumber} · scraped ${timeAgo(shipment.scrapedAt)}` }),
    );
    tip.style.display = 'block';
    // Sits to the right of the panel so it never covers the list being hovered.
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = document.getElementById('aud-panel').getBoundingClientRect();
    tip.style.left = `${Math.min(panelRect.right + 8, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.min(Math.max(8, anchorRect.top), innerHeight - tip.offsetHeight - 8)}px`;
  }

  function hideTooltip() {
    tooltip().style.display = 'none';
  }

  function itemLink(row, className, children) {
    const link = h('a', { className }, children);
    if (row.shipment.order.detailsUrl) link.href = row.shipment.order.detailsUrl;
    link.addEventListener('mouseenter', () => showTooltip(link, row));
    link.addEventListener('mouseleave', hideTooltip);
    return link;
  }

  const itemImage = ({ item }) => (item.image ? h('img', { src: item.image, alt: item.title, loading: 'lazy' }) : h('div', { className: 'aud-noimg' }));

  function renderRow(row) {
    return itemLink(row, 'aud-row', [
      itemImage(row),
      h('div', { className: 'aud-text' }, [
        h('div', { className: 'aud-eta', textContent: etaText(row.shipment, startOfToday()) }),
        h('div', { className: 'aud-name', textContent: `${row.item.quantity > 1 ? `${row.item.quantity} × ` : ''}${shortTitle(row.item.title)}` }),
      ]),
    ]);
  }

  function renderGrid(rows) {
    return h('div', { className: 'aud-grid' }, rows.map((row) => itemLink(row, '', [
      itemImage(row),
      ...(row.item.quantity > 1 ? [h('span', { className: 'aud-qty', textContent: String(row.item.quantity) })] : []),
    ])));
  }

  function renderResults(container, deliveredToday, pending, today) {
    const sections = [];
    const delivered = deliveredToday.flatMap((shipment) => shipment.items.map((item) => ({ item, shipment })));
    if (delivered.length > 0) {
      const grids = [delivered.filter((row) => row.item.imageOnly), delivered.filter((row) => !row.item.imageOnly)]
        .filter((rows) => rows.length > 0)
        .map(renderGrid);
      sections.push(h('div', {}, [
        ...grids.flatMap((grid, i) => (i === 0 ? [grid] : [h('hr'), grid])),
        h('div', { className: 'aud-caption', textContent: 'delivered today' }),
      ]));
    }
    // Items with no name on the page (grocery) render as images clustered at the top of their day.
    for (const rows of groupByDay(pending, today)) {
      const images = rows.filter((row) => row.item.imageOnly);
      const named = rows.filter((row) => !row.item.imageOnly);
      sections.push(h('div', {}, [...(images.length > 0 ? [renderGrid(images)] : []), ...named.map(renderRow)]));
    }
    container.replaceChildren(...sections.flatMap((section, i) => (i === 0 ? [section] : [h('hr'), section])));
  }

  let activeRun = 0;

  async function run({ useCache }) {
    const runId = (activeRun += 1);
    hideTooltip();
    const { title, body } = mountPanel();
    const results = h('div');
    const note = h('div', { className: 'aud-note', textContent: 'Scanning page 1…' });
    body.append(results, note);

    const pending = [];
    const deliveredToday = [];
    const today = startOfToday();
    let cachedPages = 0;
    try {
      for await (const page of scanPending(today, useCache)) {
        if (runId !== activeRun) return;
        const { pageNumber, stopReason } = page;
        if (page.cached) cachedPages += 1;
        pending.push(...page.pending);
        deliveredToday.push(...page.deliveredToday);
        title.textContent = `Not delivered yet (${pending.reduce((sum, s) => sum + s.items.length, 0)})`;
        renderResults(results, deliveredToday, pending, today);
        const pages = `${pageNumber === 1 ? '1 page' : `${pageNumber} pages`}${cachedPages ? ` (${cachedPages} cached, ↻ to refresh)` : ''}`;
        note.textContent = stopReason ? `Scanned ${pages}; stopped because ${stopReason}.` : `Scanning page ${pageNumber + 1}…`;
      }
    } catch (error) {
      if (runId !== activeRun) return;
      note.className = 'aud-note aud-error';
      note.textContent = error.message;
      console.error('[amazon-undelivered]', error);
    }
  }

  run({ useCache: true });
})();
