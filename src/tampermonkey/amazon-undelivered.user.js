// ==UserScript==
// @name         Amazon: undelivered items by day
// @namespace    stefan.scripts
// @version      1.0.0
// @description  On Your Orders, lists every item not delivered yet, grouped by arrival day starting with today.
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

  const MAX_PAGES = 15;
  const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/g;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  // Headings inside an order that aren't shipment statuses (e.g. a "Buy it again" carousel) must not swallow product links.
  const STATUS_WORDS = /arriv|ship|deliver|transit|prepar|expect|late|delay|out for|pick ?up|not yet|package|cancel|refund|return/i;
  const PRODUCT_HREF = /\/(dp|gp\/product)\//;
  const ASIN = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i;

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

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.classList.contains('a-pagination')) break;

      if (isHeading(el)) {
        if (orderHeader?.contains(el) || statusHeading?.contains(el)) continue;
        const text = norm(el.textContent);
        if (/^order placed\b/i.test(text)) {
          order = { detailsUrl: null };
          orderHeader = el;
          shipment = null;
          statusHeading = null;
        } else if (order && text.length < 120 && STATUS_WORDS.test(text)) {
          shipment = { status: text, products: new Map(), order };
          statusHeading = el;
          shipments.push(shipment);
        } else {
          shipment = null;
          statusHeading = null;
        }
        continue;
      }

      if (el.tagName !== 'A' || !order) continue;
      const text = norm(el.textContent);
      const href = el.getAttribute('href') ?? '';
      if (/^view order details$/i.test(text)) {
        order.detailsUrl = new URL(href, location.origin).href;
        continue;
      }
      const productId = shipment && href.match(PRODUCT_HREF)?.[0] && (href.match(ASIN)?.[1] ?? href);
      if (!productId) continue;
      // Each product renders as an image link followed by a title link to the same product.
      const product = shipment.products.get(productId) ?? { title: '', image: '' };
      product.title ||= text;
      product.image ||= imageSrc(el.querySelector('img'));
      shipment.products.set(productId, product);
    }

    return {
      shipments: shipments
        .map(({ products, ...rest }) => ({ ...rest, items: [...products.values()].filter((p) => p.title) }))
        .filter((s) => s.items.length > 0),
      nextUrl: findNextUrl(doc),
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
    return null;
  }

  const fmt = (date, opts) => date.toLocaleDateString('en-US', opts);
  const short = (date) => fmt(date, { month: 'short', day: 'numeric' });

  function groupLabel(range, today) {
    if (!range) return 'No date yet';
    const { start, end } = range;
    if (dayDiff(start, end) !== 0) return `${short(start)} – ${short(end)}`;
    const diff = dayDiff(start, today);
    if (diff === 0) return `Today · ${fmt(start, { weekday: 'short', month: 'short', day: 'numeric' })}`;
    if (diff === 1) return `Tomorrow · ${fmt(start, { weekday: 'short' })}`;
    if (diff < 0) return `Late · was due ${short(start)}`;
    return fmt(start, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Today first, then upcoming days, then late and undated shipments at the bottom.
  function groupRank(range, today) {
    if (!range) return [3, 0, 0];
    const startDiff = dayDiff(range.start, today);
    return [startDiff < 0 ? 2 : 1, startDiff, dayDiff(range.end, today)];
  }

  function groupShipments(shipments, today) {
    const groups = new Map();
    const todayKey = '1|0|0';
    groups.set(todayKey, { label: groupLabel({ start: today, end: today }, today), rank: [1, 0, 0], rows: [] });

    for (const shipment of shipments) {
      const range = arrivalRange(shipment.status, today);
      const rank = groupRank(range, today);
      const key = rank.join('|');
      if (!groups.has(key)) {
        groups.set(key, { label: groupLabel(range, today), rank, rows: [] });
      }
      for (const { title, image } of shipment.items) {
        groups.get(key).rows.push({ title, image, status: shipment.status, url: shipment.order.detailsUrl });
      }
    }

    return [...groups.values()].toSorted((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
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

  // Scans pages until one has nothing left to deliver, since anything older than that page is delivered too.
  // Yields after every page so the panel can show results while later pages load.
  async function* scanPending() {
    let url = firstPageUrl().href;
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const page = pageNumber === 1 && isOnFirstPage() ? parseOrdersPage(document) : await loadPage(url);
      if (page.shipments.length === 0) {
        throw new Error(`Found no orders on page ${pageNumber}. Amazon's page layout may have changed; update parseOrdersPage in src/tampermonkey/amazon-undelivered.user.js.`);
      }
      const pending = page.shipments.filter((s) => isPending(s.status));
      let stopReason = null;
      if (pending.length === 0) stopReason = `page ${pageNumber} is all delivered`;
      else if (!page.nextUrl) stopReason = `page ${pageNumber} is the last page`;
      else if (pageNumber === MAX_PAGES) stopReason = `hit the ${MAX_PAGES}-page limit`;
      yield { pageNumber, pending, stopReason };
      if (stopReason) return;
      url = page.nextUrl;
    }
  }

  const CSS = `
    #aud-panel { position: fixed; top: 110px; right: 16px; z-index: 9999; width: min(360px, calc(100vw - 32px));
      max-height: calc(100vh - 130px); overflow: auto; background: #fff; color: #0f1111; border: 1px solid #d5d9d9;
      border-radius: 8px; box-shadow: 0 4px 16px rgba(15,17,17,.15); font: 13px/1.4 "Amazon Ember", Arial, sans-serif; }
    #aud-panel header { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: #f0f2f2; border-bottom: 1px solid #d5d9d9; font-weight: 700; }
    #aud-panel header span { flex: 1; }
    #aud-panel header button { border: 0; background: none; cursor: pointer; font-size: 15px; color: #565959; padding: 0 2px; }
    #aud-panel header button:hover { color: #0f1111; }
    #aud-panel .aud-body { padding: 4px 12px 10px; }
    #aud-panel h4 { margin: 10px 0 4px; font-size: 13px; font-weight: 700; color: #007600; }
    #aud-panel h4.aud-muted { color: #565959; }
    #aud-panel .aud-row { display: flex; gap: 10px; align-items: center; padding: 4px 0; color: #0f1111; text-decoration: none; }
    #aud-panel .aud-row:hover .aud-name { color: #c7511f; text-decoration: underline; }
    #aud-panel .aud-row img, #aud-panel .aud-noimg { flex: none; width: 44px; height: 44px; object-fit: contain; border-radius: 4px; background: #f7f7f7; }
    #aud-panel .aud-text { min-width: 0; }
    #aud-panel .aud-eta { font-weight: 700; font-size: 12px; color: #007600; }
    #aud-panel .aud-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #aud-panel .aud-status { color: #565959; font-size: 12px; }
    #aud-panel .aud-note { color: #565959; font-size: 12px; margin-top: 10px; }
    #aud-panel .aud-error { color: #b12704; }
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
    const refresh = h('button', { title: 'Rescan', textContent: '↻', onclick: run });
    const close = h('button', { title: 'Close', textContent: '×', onclick: () => panel.remove() });
    const body = h('div', { className: 'aud-body' });
    const panel = h('section', { id: 'aud-panel' }, [h('header', {}, [title, refresh, close]), body]);
    document.body.append(panel);
    return { title, body };
  }

  // "Arriving tomorrow" -> "Tomorrow"; statuses without that prefix ("Out for delivery") stay as they are.
  function etaText(status) {
    const eta = status.replace(/^((now )?arriving|estimated to arrive)\s+/i, '');
    return eta.charAt(0).toUpperCase() + eta.slice(1);
  }

  function renderRow(row) {
    const image = row.image ? h('img', { src: row.image, alt: '', loading: 'lazy' }) : h('div', { className: 'aud-noimg' });
    const text = h('div', { className: 'aud-text' }, [
      h('div', { className: 'aud-eta', textContent: etaText(row.status) }),
      h('div', { className: 'aud-name', textContent: shortTitle(row.title) }),
    ]);
    const link = h('a', { className: 'aud-row', title: `${row.title}\n${row.status}` }, [image, text]);
    if (row.url) link.href = row.url;
    return link;
  }

  function renderGroups(container, groups) {
    container.replaceChildren();
    for (const group of groups) {
      container.append(h('h4', { textContent: group.label, className: group.rank[0] === 1 ? '' : 'aud-muted' }));
      if (group.rows.length === 0) {
        container.append(h('div', { className: 'aud-status', textContent: 'Nothing arriving today' }));
        continue;
      }
      container.append(...group.rows.map(renderRow));
    }
  }

  let activeRun = 0;

  async function run() {
    const runId = (activeRun += 1);
    const { title, body } = mountPanel();
    const results = h('div');
    const note = h('div', { className: 'aud-note', textContent: 'Scanning page 1…' });
    body.append(results, note);

    const pending = [];
    const today = startOfToday();
    try {
      for await (const { pageNumber, pending: pagePending, stopReason } of scanPending()) {
        if (runId !== activeRun) return;
        pending.push(...pagePending);
        title.textContent = `Not delivered yet (${pending.reduce((sum, s) => sum + s.items.length, 0)})`;
        renderGroups(results, groupShipments(pending, today));
        const pages = pageNumber === 1 ? '1 page' : `${pageNumber} pages`;
        note.textContent = stopReason ? `Scanned ${pages}; stopped because ${stopReason}.` : `Scanning page ${pageNumber + 1}…`;
      }
    } catch (error) {
      if (runId !== activeRun) return;
      note.className = 'aud-note aud-error';
      note.textContent = error.message;
      console.error('[amazon-undelivered]', error);
    }
  }

  run();
})();
