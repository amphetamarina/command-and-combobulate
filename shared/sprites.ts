export const BUILDING_NAMES = [
  "foerderturm",
  "kraftwerk",
  "raffinerie",
  "treibhaus",
] as const;

export const BUILDING_VARIANTS = [1, 2, 3] as const;

export type BuildingName = (typeof BUILDING_NAMES)[number];
export type BuildingVariant = (typeof BUILDING_VARIANTS)[number];
export type BuildingSpriteKey =
  `building/${BuildingName}/${BuildingVariant}`;

export const BUILDING_SPRITE_KEYS: readonly BuildingSpriteKey[] =
  BUILDING_NAMES.flatMap((name) =>
    BUILDING_VARIANTS.map(
      (v) => `building/${name}/${v}` as BuildingSpriteKey,
    ),
  );
