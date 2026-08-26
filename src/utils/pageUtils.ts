/**
 * Page structure of the main grid.
 *
 * Pages are explicit and user-arranged (the Launchpad model): items pack
 * from a page's first slot with no gaps, a page may be sparse (trailing
 * empty slots), a page that outgrows the viewport's capacity overflows
 * forward into the next, and an empty page is retired.
 *
 * The flat order (pages concatenated) is authoritative for sequence: the
 * main grid's drag hook owns it, the scroll layout renders it, and every
 * helper here preserves it — pages only partition it. Normalization
 * (overflow, empty-page removal) therefore never reorders items, which is
 * what lets the scroll layout ignore pages entirely.
 */

export function flattenPages(pages: string[][]): string[] {
  return pages.flat();
}

export function sizesOf(pages: string[][]): number[] {
  return pages.map((page) => page.length);
}

/**
 * Partition a flat order by page sizes. Tolerates drift either way:
 * entries beyond the sizes join the last page; sizes beyond the entries
 * yield empty pages (legitimate only mid-drag, see normalizePages).
 */
export function splitBySizes(order: string[], sizes: number[]): string[][] {
  const pages: string[][] = [];
  let start = 0;
  for (const size of sizes) {
    const end = Math.min(start + Math.max(0, size), order.length);
    pages.push(order.slice(start, end));
    start = end;
  }
  if (start < order.length) {
    const rest = order.slice(start);
    if (pages.length === 0) {
      pages.push(rest);
    } else {
      pages[pages.length - 1] = [...pages[pages.length - 1], ...rest];
    }
  }
  return pages;
}

/** Retire empty pages */
export function compactPages(pages: string[][]): string[][] {
  return pages.filter((page) => page.length > 0);
}

export function pagesEqual(a: string[][], b: string[][]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (page, i) => page.length === b[i].length && page.every((id, j) => id === b[i][j])
    )
  );
}

function locateInPages(
  pages: string[][],
  id: string
): { page: number; index: number } | null {
  for (let page = 0; page < pages.length; page++) {
    const index = pages[page].indexOf(id);
    if (index !== -1) return { page, index };
  }
  return null;
}

/** Remove an id wherever it occurs; its page may be left empty */
export function removeFromPages(pages: string[][], id: string): string[][] {
  return pages.map((page) => page.filter((other) => other !== id));
}

/** Remove ids wherever they occur, in one pass; pages may be left empty */
export function removeManyFromPages(pages: string[][], ids: Iterable<string>): string[][] {
  const drop = new Set(ids);
  return pages.map((page) => page.filter((id) => !drop.has(id)));
}

/** Append ids to the last page (created when there is none) */
export function appendToLastPage(pages: string[][], ids: string[]): string[][] {
  if (pages.length === 0) return [[...ids]];
  return pages.map((page, i) => (i === pages.length - 1 ? [...page, ...ids] : page));
}

/** Insert an id at a slot of a page; a page index past the end opens that page */
export function insertIntoPage(
  pages: string[][],
  pageIndex: number,
  slot: number,
  id: string
): string[][] {
  const result = pages.map((page) => [...page]);
  while (result.length <= pageIndex) result.push([]);
  const page = result[pageIndex];
  page.splice(Math.min(Math.max(0, slot), page.length), 0, id);
  return result;
}

/** Replace one id in place by zero or more ids; an absent id appends them to the last page */
export function replaceInPages(pages: string[][], id: string, replacement: string[]): string[][] {
  const at = locateInPages(pages, id);
  if (!at) return appendToLastPage(pages, replacement);
  return pages.map((page, i) =>
    i === at.page
      ? [...page.slice(0, at.index), ...replacement, ...page.slice(at.index + 1)]
      : page
  );
}

/**
 * Replace one page's span of the flat order with its new sequence. The
 * ids must form a contiguous span (a page); otherwise the structure
 * drifted under the page and the order is returned unchanged.
 */
export function replacePageSpan(order: string[], pageIds: string[]): string[] {
  const idSet = new Set(pageIds);
  const start = order.findIndex((id) => idSet.has(id));
  if (start === -1) return order;
  const span = order.slice(start, start + pageIds.length);
  if (span.length !== idSet.size || !span.every((id) => idSet.has(id))) return order;
  return [...order.slice(0, start), ...pageIds, ...order.slice(start + pageIds.length)];
}

/**
 * Fit pages to a capacity: a page's overflow moves to the front of the
 * next page (cascading, opening a new last page if needed), so the flat
 * sequence is unchanged. Empty pages are retired unless kept — a live
 * page drag keeps the page it emptied in place until the gesture ends,
 * so page indices don't shift under the drag.
 */
export function normalizePages(
  pages: string[][],
  capacity: number,
  keepEmpty: boolean
): string[][] {
  const result = pages.map((page) => [...page]);
  if (capacity >= 1) {
    for (let i = 0; i < result.length; i++) {
      if (result[i].length <= capacity) continue;
      const overflow = result[i].splice(capacity);
      if (i + 1 === result.length) result.push([]);
      result[i + 1] = [...overflow, ...result[i + 1]];
    }
  }
  return keepEmpty ? result : compactPages(result);
}

/**
 * Re-seat a single item after a flat reorder (the scroll layout's drops):
 * it leaves its page and joins the page of its new left neighbor, or
 * leads the first page. Every other page keeps its contents, so sparse
 * pages survive a detour through the scroll layout. The result's flat
 * sequence is newOrder.
 */
export function moveWithinPages(
  pages: string[][],
  newOrder: string[],
  movedId: string
): string[][] {
  const without = removeFromPages(pages, movedId);
  const position = newOrder.indexOf(movedId);
  if (position <= 0) return insertIntoPage(without, 0, 0, movedId);
  const left = locateInPages(without, newOrder[position - 1]);
  if (!left) return appendToLastPage(without, [movedId]);
  return insertIntoPage(without, left.page, left.index + 1, movedId);
}
