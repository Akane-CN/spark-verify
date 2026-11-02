// Evidence is read with JSON.parse, where a repeated key silently keeps its last value. Two readers that
// resolve duplicates differently would then disagree about the same bytes (for example on `verdict`), so
// every evidence file is refused when any object in it repeats a key.

/** Returns the first key that an object in `text` repeats, or undefined. `text` must already be valid JSON. */
export function findDuplicateKey(text: string): string | undefined {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (expectKey && top instanceof Set) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === "[") {
      stack.push(null);
      expectKey = false;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
    } else if (ch === ",") {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return undefined;
}

/** JSON.parse that also refuses duplicate object keys at any depth. */
export function parseJsonStrict(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const duplicate = findDuplicateKey(text);
  if (duplicate !== undefined) throw new SyntaxError(`duplicate object key ${JSON.stringify(duplicate)}`);
  return value;
}
