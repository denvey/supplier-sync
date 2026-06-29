import type { CjEndpoint } from "./constants.js";

export interface CjPointsInfo {
  usedToday?: number;
  remaining?: number;
  total?: number;
}

export interface CjEnvelope<T> {
  code: number;
  result?: boolean;
  success?: boolean;
  message?: string | null;
  data: T;
  requestId?: string | null;
  pointsInfo?: CjPointsInfo;
}

export interface CjAuthTokenData {
  openId?: number | string;
  accessToken: string;
  accessTokenExpiryDate: string;
  refreshToken: string;
  refreshTokenExpiryDate: string;
  createDate?: string;
}

export interface CjCategoryLevel3 {
  categoryId?: string;
  categoryName?: string;
  categoryThirdId?: string;
  categoryThirdName?: string;
}

export interface CjCategoryLevel2 {
  categorySecondName?: string;
  categorySecondId?: string;
  categorySecondList?: CjCategoryLevel3[];
}

export interface CjCategoryLevel1 {
  categoryFirstName?: string;
  categoryFirstId?: string;
  categoryFirstList?: CjCategoryLevel2[];
}

export interface CjWarehouse {
  areaCn?: string;
  areaEn?: string;
  areaId?: number;
  countryCode?: string;
  nameEn?: string;
  valueEn?: string;
  disabled?: boolean;
  id?: string;
  [key: string]: unknown;
}

export interface CjProductListV2Product {
  id?: string;
  nameEn?: string;
  sku?: string;
  spu?: string;
  bigImage?: string;
  sellPrice?: string | number;
  nowPrice?: string | number;
  listedNum?: number;
  categoryId?: string;
  threeCategoryName?: string;
  twoCategoryId?: string;
  twoCategoryName?: string;
  oneCategoryId?: string;
  oneCategoryName?: string;
  createAt?: number | string;
  warehouseInventoryNum?: number;
  totalVerifiedInventory?: number;
  totalUnVerifiedInventory?: number;
  saleStatus?: string | number;
  [key: string]: unknown;
}

export interface CjProductListV2Content {
  productList?: CjProductListV2Product[];
  relatedCategoryList?: unknown[];
  keyWord?: string;
  keyWordOld?: string;
}

export interface CjProductListV2Data {
  pageSize: number;
  pageNumber: number;
  totalRecords: number;
  totalPages: number;
  content?: CjProductListV2Content[];
}

export interface CjListV2Params {
  categoryId?: string;
  countryCode?: string;
  startSellPrice?: number;
  endSellPrice?: number;
  startWarehouseInventory?: number;
  endWarehouseInventory?: number;
  verifiedWarehouse?: 1 | 2;
  addMarkStatus?: 1;
  productFlag?: 0 | 1 | 2 | 3;
  timeStart?: number;
  timeEnd?: number;
  page?: number;
  size?: number;
  sort?: "asc" | "desc";
  orderBy?: 0 | 1 | 2 | 3 | 4;
  features?: string[];
}

export interface CjRequestContext {
  accountId: string;
  endpoint: CjEndpoint;
  method: "GET" | "POST";
  pointsCost: number;
}
