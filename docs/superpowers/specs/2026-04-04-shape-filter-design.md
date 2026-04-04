# Shape Filter Design

## Summary

Add a shape filter dropdown to the AssetsPage filter bar, allowing users to filter assets by image aspect ratio. No backend changes required — `width`/`height` are already stored per asset.

## Categories & Thresholds

| Label | Key | Aspect Ratio (width/height) |
|-------|-----|---------------------------|
| 方图 (Square) | `square` | 0.8 - 1.25 |
| 宽图 (Wide) | `wide` | > 1.25 |
| 竖图 (Tall) | `tall` | < 0.8 |
| 长图 (Panoramic) | `panoramic` | > 2.5 |

Note: Panoramic is a subset of Wide. An image with ratio > 2.5 matches both `wide` and `panoramic`.

## Changes

### 1. AssetsPage filter logic (`src/pages/AssetsPage.tsx`)

Add shape classification and filtering in the `filteredAssets` function, after the rating filter and before the return statement:

- Calculate aspect ratio from `asset.width / asset.height`
- Classify into categories based on thresholds
- Check if any selected shape matches the classified categories
- Skip assets without dimensions

### 2. AssetsPage filter bar UI (`src/pages/AssetsPage.tsx`)

Add a shape filter dropdown between the type filter and size filter in the filter bar. Uses the same dropdown pattern as existing filters (tag/type/rating). Shows selected count when active, with a clear button.

### 3. Store (`src/store/useAssetStore.ts`)

No changes needed — `shapeFilter: string[] | null` and `setShapeFilter` are already defined. The `SHAPE_FILTER_OPTIONS` constant is already defined in AssetsPage.

## Pattern

Follows the existing filter pattern: Zustand state → filter in `filteredAssets` → dropdown UI in filter bar. Multi-select supported.
