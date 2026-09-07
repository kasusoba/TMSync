import type { Transform } from "./schema";

/**
 * Apply a single declarative transform to a raw string. `toInt` is the only
 * transform that can fail to produce a meaningful value; it returns "" when the
 * string holds no digits, which the engine treats as an unreadable field.
 */
function applyOne(value: string, transform: Transform): string {
  switch (transform) {
    case "trim":
      return value.trim();
    case "lowercase":
      return value.toLowerCase();
    case "uppercase":
      return value.toUpperCase();
    case "collapseSpaces":
      return value.replace(/\s+/g, " ").trim();
    case "deslugify":
      // Hyphen/underscore separated slug → spaced words. Applied only where the
      // picker saw a slug-shaped value, so a real hyphen ("Spider-Man") is never
      // broken up by accident.
      return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    case "toInt": {
      const match = value.match(/-?\d+/);
      return match ? String(Number.parseInt(match[0], 10)) : "";
    }
  }
}

export function applyTransforms(value: string, transforms: Transform[] | undefined): string {
  if (!transforms) return value;
  return transforms.reduce(applyOne, value);
}
