import type { AppInfo } from "@/types/app";

/**
 * Build a lookup map from an array of apps, keyed by app path.
 */
export function buildAppsMap(apps: AppInfo[]): Map<string, AppInfo> {
  return new Map(apps.map((app) => [app.path, app]));
}

/** Category slugs whose display name isn't plain title-casing */
const CATEGORY_NAMES: Record<string, string> = {
  "developer-tools": "Developer Tools",
  "graphics-design": "Graphics & Design",
  "healthcare-fitness": "Health & Fitness",
  "food-drink": "Food & Drink",
  "social-networking": "Social Networking",
};

/**
 * Human-readable name for an LSApplicationCategoryType identifier,
 * e.g. "public.app-category.developer-tools" -> "Developer Tools".
 * Game subcategories collapse to "Games" like original Launchpad.
 * Returns null for missing or unrecognizable identifiers.
 */
const CATEGORY_PREFIX = "public.app-category.";

export function categoryDisplayName(categoryType: string | null | undefined): string | null {
  if (!categoryType?.startsWith(CATEGORY_PREFIX)) return null;
  const slug = categoryType.slice(CATEGORY_PREFIX.length);
  if (!slug) return null;

  if (slug === "games" || slug.endsWith("-games")) return "Games";

  const special = CATEGORY_NAMES[slug];
  if (special) return special;

  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A prefix that stops inside a word must reach this many characters:
 *  "Text" from TextEdit and TextMate, not "i" from iMovie and iPhoto */
const MIN_PARTIAL_WORD_PREFIX = 4;

/** Leading words that name nothing on their own: "The" from The Sims and
 *  The Unarchiver is no folder name, where a two-letter brand ("HP") is */
const STOPWORDS = new Set(["the", "a", "an", "my", "your"]);

interface Shared {
  phrase: string;
  count: number;
}

/**
 * The name at least half of these app names begin with, for a folder
 * whose apps share no category: whole leading words first ("Final Cut"
 * for Final Cut Pro and Final Cut Camera), else the start of a word
 * ("Garage" for GarageBand and Garage Door). Either way the most widely
 * held prefix wins, the longest among equally held ones: a two-word
 * phrase held by the minimum must not outname a brand every app carries
 * ("Microsoft", not "Microsoft Teams", for Teams, Teams Classic, Word
 * and Excel). Compared case-insensitively, returned in the first
 * holder's casing. Null when the names share nothing worth saying.
 */
export function sharedNamePrefix(names: string[]): string | null {
  if (names.length < 2) return null;
  const needed = Math.max(2, Math.ceil(names.length / 2));
  let best: Shared | null = null;

  // Longest phrases first, so a tie in holders keeps the longer one
  const words = names.map((name) => name.trim().split(/\s+/).filter(Boolean));
  const maxWords = Math.max(...words.map((w) => w.length));
  for (let count = maxWords; count >= 1; count--) {
    const found = mostShared(
      words.map((w) => {
        if (w.length < count) return null;
        const phrase = w.slice(0, count).join(" ");
        return count === 1 && STOPWORDS.has(phrase.toLowerCase()) ? null : phrase;
      }),
      needed
    );
    if (found && (best === null || found.count > best.count)) best = found;
  }
  if (best) return best.phrase;

  const maxLength = Math.max(...names.map((name) => name.length));
  for (let length = maxLength; length >= MIN_PARTIAL_WORD_PREFIX; length--) {
    const found = mostShared(
      names.map((name) => (name.length >= length ? name.slice(0, length) : null)),
      needed
    );
    if (!found) continue;
    const phrase = found.phrase.replace(/[^\p{L}\p{N}]+$/u, "");
    if (phrase.length < MIN_PARTIAL_WORD_PREFIX) continue;
    if (best === null || found.count > best.count) best = { phrase, count: found.count };
  }
  return best?.phrase ?? null;
}

/** The candidate held by the most entries, provided at least `needed`
 *  hold it (case-insensitively; null entries hold nothing), in its first
 *  holder's casing */
function mostShared(candidates: (string | null)[], needed: number): Shared | null {
  const groups = new Map<string, Shared>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { phrase: candidate, count: 1 });
    }
  }
  let best: Shared | null = null;
  for (const group of groups.values()) {
    if (group.count >= needed && (best === null || group.count > best.count)) best = group;
  }
  return best;
}
