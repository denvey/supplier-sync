import http from "node:http";
import { URL } from "node:url";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { createDb } from "./db/client.js";
import { cjAccounts, cjProductIndexes } from "./db/schema.js";

const defaultPort = 4173;
const defaultHost = "127.0.0.1";
const pageSizeOptions = [20, 50, 100] as const;

type PageSize = typeof pageSizeOptions[number];
type ProductSort = "syncedAt" | "createdAt" | "priceAsc" | "priceDesc";

type ProductListQuery = {
  q: string;
  countryCode: string;
  categoryId: string;
  page: number;
  pageSize: PageSize;
  sort: ProductSort;
};

const { db, client } = createDb();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "GET") {
      sendText(response, 405, "Method not allowed");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (requestUrl.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (requestUrl.pathname === "/api/products") {
      const payload = await getProducts(parseProductListQuery(requestUrl.searchParams));
      sendJson(response, 200, payload);
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/products") {
      sendHtml(response, 200, renderProductListPage());
      return;
    }

    sendText(response, 404, "Not found");
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

const port = parsePort(process.env.PORT);
const host = process.env.HOST ?? defaultHost;
server.listen(port, host, () => {
  console.log(`Product list page: http://${host}:${port}/products`);
});

process.on("SIGINT", () => {
  void closeServer();
});

process.on("SIGTERM", () => {
  void closeServer();
});

async function closeServer() {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  await client.end();
}

async function getProducts(query: ProductListQuery) {
  const where = buildProductWhere(query);
  const [countRows, countries, categories] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(cjProductIndexes)
      .where(where),
    db.select({ value: cjProductIndexes.countryCode })
      .from(cjProductIndexes)
      .groupBy(cjProductIndexes.countryCode)
      .orderBy(asc(cjProductIndexes.countryCode))
      .limit(200),
    db.select({
      id: cjProductIndexes.categoryId,
      name: cjProductIndexes.categoryName
    })
      .from(cjProductIndexes)
      .where(sql`${cjProductIndexes.categoryId} is not null`)
      .groupBy(cjProductIndexes.categoryId, cjProductIndexes.categoryName)
      .orderBy(asc(cjProductIndexes.categoryName), asc(cjProductIndexes.categoryId))
      .limit(300)
  ]);

  const total = countRows[0]?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const offset = (page - 1) * query.pageSize;

  const rows = await db.select({
    id: cjProductIndexes.id,
    accountName: cjAccounts.name,
    pid: cjProductIndexes.pid,
    countryCode: cjProductIndexes.countryCode,
    spu: cjProductIndexes.spu,
    sku: cjProductIndexes.sku,
    title: cjProductIndexes.title,
    mainImage: cjProductIndexes.mainImage,
    categoryId: cjProductIndexes.categoryId,
    categoryName: cjProductIndexes.categoryName,
    sellPrice: cjProductIndexes.sellPrice,
    nowPrice: cjProductIndexes.nowPrice,
    listedNum: cjProductIndexes.listedNum,
    warehouseInventoryNum: cjProductIndexes.warehouseInventoryNum,
    totalVerifiedInventory: cjProductIndexes.totalVerifiedInventory,
    totalUnverifiedInventory: cjProductIndexes.totalUnverifiedInventory,
    createAt: cjProductIndexes.createAt,
    saleStatus: cjProductIndexes.saleStatus,
    syncedAt: cjProductIndexes.syncedAt
  })
    .from(cjProductIndexes)
    .leftJoin(cjAccounts, eq(cjProductIndexes.accountId, cjAccounts.id))
    .where(where)
    .orderBy(...getProductOrderBy(query.sort))
    .limit(query.pageSize)
    .offset(offset);

  return {
    query: { ...query, page },
    total,
    totalPages,
    products: rows,
    filters: {
      countries: countries.map((country) => country.value),
      categories: categories
        .filter((category): category is { id: string; name: string | null } => Boolean(category.id))
        .map((category) => ({
          id: category.id,
          name: category.name ?? category.id
        }))
    }
  };
}

function buildProductWhere(query: ProductListQuery): SQL {
  const clauses: SQL[] = [sql`true`];

  if (query.q) {
    const keyword = `%${query.q}%`;
    const textSearch = or(
      ilike(cjProductIndexes.title, keyword),
      ilike(cjProductIndexes.pid, keyword),
      ilike(cjProductIndexes.spu, keyword),
      ilike(cjProductIndexes.sku, keyword),
      ilike(cjProductIndexes.categoryName, keyword)
    );
    if (textSearch) {
      clauses.push(textSearch);
    }
  }

  if (query.countryCode) {
    clauses.push(eq(cjProductIndexes.countryCode, query.countryCode));
  }

  if (query.categoryId) {
    clauses.push(eq(cjProductIndexes.categoryId, query.categoryId));
  }

  return and(...clauses) ?? sql`true`;
}

function getProductOrderBy(sort: ProductSort): SQL[] {
  switch (sort) {
    case "createdAt":
      return [sql`${cjProductIndexes.createAt} desc nulls last`, desc(cjProductIndexes.syncedAt)];
    case "priceAsc":
      return [sql`${cjProductIndexes.nowPrice} asc nulls last`, desc(cjProductIndexes.syncedAt)];
    case "priceDesc":
      return [sql`${cjProductIndexes.nowPrice} desc nulls last`, desc(cjProductIndexes.syncedAt)];
    case "syncedAt":
    default:
      return [desc(cjProductIndexes.syncedAt), desc(cjProductIndexes.updatedAt)];
  }
}

function parseProductListQuery(searchParams: URLSearchParams): ProductListQuery {
  const pageSize = parsePageSize(searchParams.get("pageSize"));
  return {
    q: normalizeSearchValue(searchParams.get("q"), 120),
    countryCode: normalizeSearchValue(searchParams.get("countryCode"), 40),
    categoryId: normalizeSearchValue(searchParams.get("categoryId"), 80),
    page: Math.max(1, parseInteger(searchParams.get("page"), 1)),
    pageSize,
    sort: parseSort(searchParams.get("sort"))
  };
}

function parsePageSize(value: string | null): PageSize {
  const parsed = parseInteger(value, 20);
  return pageSizeOptions.includes(parsed as PageSize) ? parsed as PageSize : 20;
}

function parseSort(value: string | null): ProductSort {
  if (value === "createdAt" || value === "priceAsc" || value === "priceDesc" || value === "syncedAt") {
    return value;
  }
  return "syncedAt";
}

function parseInteger(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSearchValue(value: string | null, maxLength: number) {
  return (value ?? "").trim().slice(0, maxLength);
}

function parsePort(value: string | undefined) {
  if (!value) {
    return defaultPort;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultPort;
}

function sendHtml(response: http.ServerResponse, statusCode: number, html: string) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response: http.ServerResponse, statusCode: number, text: string) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(text);
}

function renderProductListPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CJ 商品列表</title>
  <style>
    :root {
      color-scheme: light;
      --page: #f5f7fa;
      --surface: #ffffff;
      --surface-soft: #eef3f8;
      --line: #d8e0ea;
      --line-strong: #c7d2df;
      --text: #172033;
      --muted: #657386;
      --muted-strong: #425064;
      --primary: #2457a6;
      --primary-dark: #173f7d;
      --primary-soft: #e6effc;
      --success: #087443;
      --success-soft: #e5f5ed;
      --warning: #9a6700;
      --warning-soft: #fff3d6;
      --danger: #ba2b20;
      --danger-soft: #fde8e5;
      --shadow: 0 16px 40px rgba(25, 37, 56, 0.08);
      --radius: 8px;
      font-family: Aptos, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--page);
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
      text-wrap: pretty;
    }

    button,
    input,
    select {
      font: inherit;
    }

    .app-shell {
      width: min(1320px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }

    .topbar {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }

    h1 {
      margin: 0;
      font-size: clamp(24px, 3vw, 34px);
      line-height: 1.1;
      letter-spacing: 0;
    }

    .subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(120px, 1fr));
      gap: 8px;
      min-width: 280px;
    }

    .summary-item {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      padding: 10px 12px;
      box-shadow: 0 1px 0 rgba(23, 32, 51, 0.03);
    }

    .summary-label {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }

    .summary-value {
      display: block;
      margin-top: 2px;
      color: var(--text);
      font-size: 20px;
      font-weight: 700;
      line-height: 1.1;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .filters {
      display: grid;
      grid-template-columns: minmax(220px, 1.4fr) repeat(4, minmax(140px, 1fr)) auto;
      gap: 10px;
      align-items: end;
      padding: 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
    }

    .field {
      min-width: 0;
    }

    label {
      display: block;
      margin-bottom: 6px;
      color: var(--muted-strong);
      font-size: 12px;
      font-weight: 650;
    }

    input,
    select {
      width: 100%;
      height: 38px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #ffffff;
      color: var(--text);
      padding: 0 10px;
      outline: none;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }

    input:focus,
    select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(36, 87, 166, 0.14);
    }

    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .button {
      height: 38px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0 14px;
      background: var(--primary);
      color: #ffffff;
      font-weight: 700;
      cursor: pointer;
      transition: background 140ms ease, transform 140ms ease, border-color 140ms ease;
      white-space: nowrap;
    }

    .button:hover {
      background: var(--primary-dark);
    }

    .button:active {
      transform: translateY(1px);
    }

    .button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      transform: none;
    }

    .button.secondary {
      background: #ffffff;
      color: var(--primary);
      border-color: var(--line-strong);
    }

    .button.secondary:hover {
      background: var(--primary-soft);
      border-color: #aac2e8;
    }

    .table-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }

    .status-text {
      color: var(--muted);
      font-size: 13px;
    }

    .pager {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .page-indicator {
      min-width: 92px;
      color: var(--muted-strong);
      text-align: center;
      font-size: 13px;
    }

    .table-wrap {
      overflow: auto;
      background: #ffffff;
    }

    table {
      width: 100%;
      min-width: 1040px;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: middle;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--surface-soft);
      color: var(--muted-strong);
      font-size: 12px;
      font-weight: 750;
      white-space: nowrap;
    }

    tbody tr {
      transition: background 120ms ease;
    }

    tbody tr:hover {
      background: #f8fbff;
    }

    .product-cell {
      display: grid;
      grid-template-columns: 52px minmax(220px, 1fr);
      gap: 10px;
      align-items: center;
      min-width: 0;
    }

    .thumb,
    .no-image {
      width: 52px;
      height: 52px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #eef2f6;
    }

    .thumb {
      display: block;
      object-fit: cover;
    }

    .no-image {
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }

    .product-title {
      max-width: 460px;
      color: var(--text);
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .product-meta {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    .price {
      color: var(--text);
      font-weight: 750;
      white-space: nowrap;
    }

    .muted {
      color: var(--muted);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 2px 9px;
      font-size: 12px;
      font-weight: 750;
      white-space: nowrap;
    }

    .badge.neutral {
      background: var(--primary-soft);
      color: var(--primary-dark);
    }

    .badge.success {
      background: var(--success-soft);
      color: var(--success);
    }

    .badge.warning {
      background: var(--warning-soft);
      color: var(--warning);
    }

    .badge.danger {
      background: var(--danger-soft);
      color: var(--danger);
    }

    .empty-state,
    .error-state {
      display: none;
      padding: 42px 16px;
      text-align: center;
      color: var(--muted);
    }

    .empty-state strong,
    .error-state strong {
      display: block;
      margin-bottom: 6px;
      color: var(--text);
      font-size: 16px;
    }

    .loading tbody {
      opacity: 0.5;
    }

    @media (max-width: 980px) {
      .topbar {
        align-items: stretch;
        flex-direction: column;
      }

      .summary {
        min-width: 0;
      }

      .filters {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .actions {
        grid-column: 1 / -1;
        justify-content: flex-end;
      }
    }

    @media (max-width: 640px) {
      .app-shell {
        width: min(100vw - 20px, 1320px);
        padding-top: 16px;
      }

      .filters {
        grid-template-columns: 1fr;
      }

      .actions,
      .table-toolbar {
        align-items: stretch;
        flex-direction: column;
      }

      .button {
        width: 100%;
      }

      .pager {
        width: 100%;
        justify-content: space-between;
      }

      .table-wrap {
        overflow: visible;
      }

      table {
        min-width: 0;
      }

      thead {
        display: none;
      }

      tbody,
      tr,
      td {
        display: block;
      }

      tbody tr {
        padding: 12px;
        border-bottom: 1px solid var(--line);
      }

      td {
        border-bottom: 0;
        padding: 5px 0;
      }

      td:not(:first-child) {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        word-break: break-word;
      }

      td:not(:first-child)::before {
        content: attr(data-label);
        flex: 0 0 72px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      td:first-child {
        padding-bottom: 9px;
      }

      .product-cell {
        grid-template-columns: 52px minmax(0, 1fr);
      }

      .product-title {
        max-width: none;
        display: -webkit-box;
        overflow: hidden;
        white-space: normal;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }

      .product-meta {
        white-space: normal;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <h1>CJ 商品列表</h1>
        <p class="subtitle">查看本地已同步的商品索引，支持搜索、筛选和分页。</p>
      </div>
      <section class="summary" aria-label="商品概览">
        <div class="summary-item">
          <span class="summary-label">筛选结果</span>
          <span class="summary-value" id="summary-total">--</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">当前页</span>
          <span class="summary-value" id="summary-page">--</span>
        </div>
      </section>
    </header>

    <section class="panel" aria-label="商品列表">
      <form class="filters" id="filters">
        <div class="field">
          <label for="q">搜索</label>
          <input id="q" name="q" type="search" placeholder="标题 / PID / SKU / SPU / 类目" autocomplete="off">
        </div>
        <div class="field">
          <label for="countryCode">国家/仓库</label>
          <select id="countryCode" name="countryCode">
            <option value="">全部国家</option>
          </select>
        </div>
        <div class="field">
          <label for="categoryId">类目</label>
          <select id="categoryId" name="categoryId">
            <option value="">全部类目</option>
          </select>
        </div>
        <div class="field">
          <label for="sort">排序</label>
          <select id="sort" name="sort">
            <option value="syncedAt">最近同步</option>
            <option value="createdAt">商品创建时间</option>
            <option value="priceAsc">价格从低到高</option>
            <option value="priceDesc">价格从高到低</option>
          </select>
        </div>
        <div class="field">
          <label for="pageSize">每页</label>
          <select id="pageSize" name="pageSize">
            <option value="20">20 条</option>
            <option value="50">50 条</option>
            <option value="100">100 条</option>
          </select>
        </div>
        <div class="actions">
          <button class="button" type="submit">查询</button>
          <button class="button secondary" id="reset" type="button">重置</button>
        </div>
      </form>

      <div class="table-toolbar">
        <div class="status-text" id="status">准备加载商品</div>
        <div class="pager">
          <button class="button secondary" id="prev" type="button">上一页</button>
          <span class="page-indicator" id="page-indicator">-- / --</span>
          <button class="button secondary" id="next" type="button">下一页</button>
        </div>
      </div>

      <div class="table-wrap" id="table-wrap">
        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th>PID</th>
              <th>国家</th>
              <th>类目</th>
              <th>价格</th>
              <th>库存</th>
              <th>上架数</th>
              <th>状态</th>
              <th>同步时间</th>
            </tr>
          </thead>
          <tbody id="products"></tbody>
        </table>
        <div class="empty-state" id="empty">
          <strong>没有匹配商品</strong>
          调整搜索条件或先执行同步命令导入商品索引。
        </div>
        <div class="error-state" id="error">
          <strong>加载失败</strong>
          <span id="error-message"></span>
        </div>
      </div>
    </section>
  </main>

  <script>
    const elements = {
      form: document.querySelector("#filters"),
      q: document.querySelector("#q"),
      countryCode: document.querySelector("#countryCode"),
      categoryId: document.querySelector("#categoryId"),
      sort: document.querySelector("#sort"),
      pageSize: document.querySelector("#pageSize"),
      products: document.querySelector("#products"),
      panel: document.querySelector(".panel"),
      empty: document.querySelector("#empty"),
      error: document.querySelector("#error"),
      errorMessage: document.querySelector("#error-message"),
      status: document.querySelector("#status"),
      prev: document.querySelector("#prev"),
      next: document.querySelector("#next"),
      reset: document.querySelector("#reset"),
      pageIndicator: document.querySelector("#page-indicator"),
      summaryTotal: document.querySelector("#summary-total"),
      summaryPage: document.querySelector("#summary-page")
    };

    const state = {
      page: 1,
      totalPages: 1,
      total: 0,
      filtersReady: false
    };

    hydrateFormFromUrl();
    loadProducts();

    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      state.page = 1;
      loadProducts();
    });

    elements.pageSize.addEventListener("change", () => {
      state.page = 1;
      loadProducts();
    });

    elements.sort.addEventListener("change", () => {
      state.page = 1;
      loadProducts();
    });

    elements.prev.addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        loadProducts();
      }
    });

    elements.next.addEventListener("click", () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        loadProducts();
      }
    });

    elements.reset.addEventListener("click", () => {
      elements.q.value = "";
      elements.countryCode.value = "";
      elements.categoryId.value = "";
      elements.sort.value = "syncedAt";
      elements.pageSize.value = "20";
      state.page = 1;
      loadProducts();
    });

    async function loadProducts() {
      setLoading(true);
      elements.error.style.display = "none";
      elements.empty.style.display = "none";

      try {
        const params = buildParams();
        const response = await fetch("/api/products?" + params.toString(), {
          headers: { accept: "application/json" }
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "请求失败");
        }

        state.page = payload.query.page;
        state.totalPages = payload.totalPages;
        state.total = payload.total;
        updateUrl(params);
        renderFilters(payload.filters);
        renderRows(payload.products);
        renderSummary();
      } catch (error) {
        elements.products.replaceChildren();
        elements.errorMessage.textContent = error instanceof Error ? error.message : "未知错误";
        elements.error.style.display = "block";
        elements.status.textContent = "商品加载失败";
      } finally {
        setLoading(false);
      }
    }

    function buildParams() {
      const params = new URLSearchParams();
      const q = elements.q.value.trim();
      if (q) params.set("q", q);
      if (elements.countryCode.value) params.set("countryCode", elements.countryCode.value);
      if (elements.categoryId.value) params.set("categoryId", elements.categoryId.value);
      params.set("sort", elements.sort.value);
      params.set("pageSize", elements.pageSize.value);
      params.set("page", String(state.page));
      return params;
    }

    function hydrateFormFromUrl() {
      const params = new URLSearchParams(window.location.search);
      elements.q.value = params.get("q") || "";
      elements.countryCode.dataset.pendingValue = params.get("countryCode") || "";
      elements.categoryId.dataset.pendingValue = params.get("categoryId") || "";
      elements.sort.value = params.get("sort") || "syncedAt";
      elements.pageSize.value = params.get("pageSize") || "20";
      state.page = Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1);
    }

    function updateUrl(params) {
      const nextUrl = params.toString() ? "/products?" + params.toString() : "/products";
      window.history.replaceState(null, "", nextUrl);
    }

    function renderFilters(filters) {
      const selectedCountry = elements.countryCode.dataset.pendingValue || elements.countryCode.value;
      const selectedCategory = elements.categoryId.dataset.pendingValue || elements.categoryId.value;
      replaceOptions(elements.countryCode, [{ value: "", label: "全部国家" }].concat(
        filters.countries.map((country) => ({ value: country, label: country }))
      ), selectedCountry);
      replaceOptions(elements.categoryId, [{ value: "", label: "全部类目" }].concat(
        filters.categories.map((category) => ({
          value: category.id,
          label: category.name === category.id ? category.id : category.name + " (" + category.id + ")"
        }))
      ), selectedCategory);
      delete elements.countryCode.dataset.pendingValue;
      delete elements.categoryId.dataset.pendingValue;
    }

    function replaceOptions(select, options, selectedValue) {
      const fragment = document.createDocumentFragment();
      for (const option of options) {
        const node = document.createElement("option");
        node.value = option.value;
        node.textContent = option.label;
        fragment.appendChild(node);
      }
      select.replaceChildren(fragment);
      select.value = selectedValue;
      if (select.value !== selectedValue) {
        select.value = "";
      }
    }

    function renderRows(products) {
      elements.products.replaceChildren();

      if (products.length === 0) {
        elements.empty.style.display = "block";
        elements.status.textContent = "没有匹配商品";
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const product of products) {
        const row = document.createElement("tr");
        row.appendChild(renderProductCell(product));
        row.appendChild(textCell(product.pid, "mono", "PID"));
        row.appendChild(textCell(product.countryCode, "", "国家"));
        row.appendChild(textCell(product.categoryName || product.categoryId || "--", "", "类目"));
        row.appendChild(textCell(formatPrice(product.nowPrice, product.sellPrice), "price", "价格"));
        row.appendChild(renderInventoryCell(product));
        row.appendChild(textCell(formatNumber(product.listedNum), "", "上架数"));
        row.appendChild(renderStatusCell(product.saleStatus));
        row.appendChild(textCell(formatDate(product.syncedAt), "", "同步时间"));
        fragment.appendChild(row);
      }

      elements.products.appendChild(fragment);
      elements.status.textContent = "已加载 " + products.length + " 条商品";
    }

    function renderProductCell(product) {
      const cell = document.createElement("td");
      cell.dataset.label = "商品";
      const wrap = document.createElement("div");
      wrap.className = "product-cell";

      if (product.mainImage) {
        const image = document.createElement("img");
        image.className = "thumb";
        image.src = product.mainImage;
        image.alt = product.title || product.pid;
        image.loading = "lazy";
        image.addEventListener("error", () => {
          image.replaceWith(createImagePlaceholder());
        }, { once: true });
        wrap.appendChild(image);
      } else {
        wrap.appendChild(createImagePlaceholder());
      }

      const content = document.createElement("div");
      const title = document.createElement("div");
      title.className = "product-title";
      title.textContent = product.title || "未命名商品";
      title.title = product.title || "";
      const meta = document.createElement("div");
      meta.className = "product-meta";
      meta.textContent = [product.spu && "SPU " + product.spu, product.sku && "SKU " + product.sku]
        .filter(Boolean)
        .join(" · ") || "无 SKU/SPU";
      content.append(title, meta);
      wrap.appendChild(content);
      cell.appendChild(wrap);
      return cell;
    }

    function createImagePlaceholder() {
      const placeholder = document.createElement("div");
      placeholder.className = "no-image";
      placeholder.textContent = "IMG";
      return placeholder;
    }

    function renderInventoryCell(product) {
      const verified = asNumber(product.totalVerifiedInventory);
      const warehouse = asNumber(product.warehouseInventoryNum);
      const value = verified ?? warehouse;
      const cell = document.createElement("td");
      cell.dataset.label = "库存";
      const badge = document.createElement("span");
      badge.className = "badge " + getInventoryClass(value);
      badge.textContent = value == null ? "--" : formatNumber(value);
      cell.appendChild(badge);
      return cell;
    }

    function renderStatusCell(status) {
      const cell = document.createElement("td");
      cell.dataset.label = "状态";
      const badge = document.createElement("span");
      badge.className = "badge neutral";
      badge.textContent = status || "--";
      cell.appendChild(badge);
      return cell;
    }

    function textCell(value, className, label) {
      const cell = document.createElement("td");
      cell.textContent = value == null || value === "" ? "--" : String(value);
      if (label) {
        cell.dataset.label = label;
      }
      if (className) {
        cell.className = className;
      }
      return cell;
    }

    function renderSummary() {
      elements.summaryTotal.textContent = formatNumber(state.total);
      elements.summaryPage.textContent = String(state.page);
      elements.pageIndicator.textContent = state.page + " / " + state.totalPages;
      elements.prev.disabled = state.page <= 1;
      elements.next.disabled = state.page >= state.totalPages;
    }

    function setLoading(isLoading) {
      elements.panel.classList.toggle("loading", isLoading);
      elements.status.textContent = isLoading ? "正在加载商品..." : elements.status.textContent;
      elements.prev.disabled = isLoading || state.page <= 1;
      elements.next.disabled = isLoading || state.page >= state.totalPages;
    }

    function formatPrice(nowPrice, sellPrice) {
      const price = nowPrice ?? sellPrice;
      if (price == null || price === "") {
        return "--";
      }
      const amount = Number(price);
      return Number.isFinite(amount) ? "$" + amount.toFixed(2) : String(price);
    }

    function formatNumber(value) {
      if (value == null || value === "") {
        return "--";
      }
      const number = Number(value);
      return Number.isFinite(number) ? new Intl.NumberFormat("zh-CN").format(number) : String(value);
    }

    function formatDate(value) {
      if (!value) {
        return "--";
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "--";
      }
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
    }

    function asNumber(value) {
      if (value == null || value === "") {
        return null;
      }
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function getInventoryClass(value) {
      if (value == null) {
        return "neutral";
      }
      if (value <= 0) {
        return "danger";
      }
      if (value < 20) {
        return "warning";
      }
      return "success";
    }
  </script>
</body>
</html>`;
}
