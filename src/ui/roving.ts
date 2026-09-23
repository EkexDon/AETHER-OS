/**
 * Arrow-key navigation for tablists, radio groups and toolbars.
 * Returns the index to move to, or `null` when the key is not a navigation
 * key. Wraps around at both ends and skips disabled items.
 */
export function nextRovingIndex(
  key: string,
  current: number,
  count: number,
  orientation: "horizontal" | "vertical" = "horizontal",
  isDisabled: (index: number) => boolean = () => false
): number | null {
  if (count <= 0) return null;
  const prevKeys = orientation === "horizontal" ? ["ArrowLeft"] : ["ArrowUp"];
  const nextKeys = orientation === "horizontal" ? ["ArrowRight"] : ["ArrowDown"];

  let direction = 0;
  let start = current;
  if (prevKeys.includes(key)) direction = -1;
  else if (nextKeys.includes(key)) direction = 1;
  else if (key === "Home") {
    direction = 1;
    start = -1;
  } else if (key === "End") {
    direction = -1;
    start = count;
  } else return null;

  for (let step = 1; step <= count; step++) {
    const idx = (((start + direction * step) % count) + count) % count;
    if (!isDisabled(idx)) return idx;
  }
  return null;
}
