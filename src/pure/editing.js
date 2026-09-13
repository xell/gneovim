// The run of text present in `after` but not `before`.
export function diffInserted(before, after) {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  return after.slice(prefix, after.length - suffix);
}

export function minimalEdit(before, after) {
  let prefix = 0;
  const maximumPrefix = Math.min(before.length, after.length);
  while (prefix < maximumPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  const maximumSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maximumSuffix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++;

  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
