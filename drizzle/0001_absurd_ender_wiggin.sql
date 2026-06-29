ALTER TABLE "cj_product_indexes" ADD COLUMN "sell_price_max" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "cj_product_indexes" ADD COLUMN "now_price_max" numeric(12, 2);
--> statement-breakpoint
WITH price_ranges AS (
  SELECT
    id,
    (
      SELECT (match[1])::numeric(12, 2)
      FROM regexp_matches(raw->>'sellPrice', '([0-9]+(\.[0-9]+)?)', 'g') WITH ORDINALITY AS matches(match, ord)
      ORDER BY ord ASC
      LIMIT 1
    ) AS sell_price_min,
    (
      SELECT (match[1])::numeric(12, 2)
      FROM regexp_matches(raw->>'sellPrice', '([0-9]+(\.[0-9]+)?)', 'g') WITH ORDINALITY AS matches(match, ord)
      ORDER BY ord DESC
      LIMIT 1
    ) AS sell_price_max,
    (
      SELECT (match[1])::numeric(12, 2)
      FROM regexp_matches(raw->>'nowPrice', '([0-9]+(\.[0-9]+)?)', 'g') WITH ORDINALITY AS matches(match, ord)
      ORDER BY ord ASC
      LIMIT 1
    ) AS now_price_min,
    (
      SELECT (match[1])::numeric(12, 2)
      FROM regexp_matches(raw->>'nowPrice', '([0-9]+(\.[0-9]+)?)', 'g') WITH ORDINALITY AS matches(match, ord)
      ORDER BY ord DESC
      LIMIT 1
    ) AS now_price_max
  FROM "cj_product_indexes"
)
UPDATE "cj_product_indexes" AS product
SET
  "sell_price" = COALESCE(product."sell_price", price_ranges.sell_price_min),
  "sell_price_max" = price_ranges.sell_price_max,
  "now_price" = COALESCE(product."now_price", price_ranges.now_price_min),
  "now_price_max" = price_ranges.now_price_max
FROM price_ranges
WHERE product.id = price_ranges.id;
