export const CJ_ENDPOINTS = {
  getAccessToken: "/authentication/getAccessToken",
  refreshAccessToken: "/authentication/refreshAccessToken",
  getCategory: "/product/getCategory",
  globalWarehouseList: "/product/globalWarehouseList",
  productListV2: "/product/listV2",
  productQuery: "/product/query",
  variantQuery: "/product/variant/query",
  inventoryByPid: "/product/stock/getInventoryByPid"
} as const;

export type CjEndpoint = typeof CJ_ENDPOINTS[keyof typeof CJ_ENDPOINTS];

export const CJ_ENDPOINT_POINT_COST: Record<CjEndpoint, number> = {
  [CJ_ENDPOINTS.getAccessToken]: 0,
  [CJ_ENDPOINTS.refreshAccessToken]: 0,
  [CJ_ENDPOINTS.getCategory]: 0,
  [CJ_ENDPOINTS.globalWarehouseList]: 0,
  [CJ_ENDPOINTS.productListV2]: 50,
  [CJ_ENDPOINTS.productQuery]: 10,
  [CJ_ENDPOINTS.variantQuery]: 10,
  [CJ_ENDPOINTS.inventoryByPid]: 10
};

export const CJ_NEW_ACCOUNT_POINTS_EFFECTIVE_AT = new Date("2026-06-01T00:00:00.000Z");
export const CJ_OLD_ACCOUNT_POINTS_EFFECTIVE_AT = new Date("2026-07-01T00:00:00.000Z");
export const CJ_LIST_V2_PAGE_SIZE = 100;
export const CJ_LIST_V2_MAX_PAGE = 1000;
export const CJ_LIST_V2_MAX_TOTAL_RECORDS = 6000;
export const CJ_LIST_V2_SPLIT_THRESHOLD = 5900;
export const CJ_GLOBAL_COUNTRY_CODE = "GLOBAL";
