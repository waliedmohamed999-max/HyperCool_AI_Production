# Declarative Data Mapping Engine (Phase 6C)

`src/connectors/core/mapping.js` — `applyMapping()`. The ONE canonical mapper: Phase 6B's
Generic REST response mapping (`generic-rest/mapping.js`'s `applyResponseMapping`) now delegates
here unchanged; the Generic Webhook Framework uses it for exactly the same purpose (extracting a
normalized result from untrusted external data). No second, divergent mapper exists.

## Mapping language (Part 29/32-35, 90)

A single JSON path syntax: dot-separated segments (`"a.b.c"`), resolved via
`Object.prototype.hasOwnProperty` checks only (never through the prototype chain). Node shapes:

| Shape | Meaning |
|---|---|
| `"a.b"` (plain string) | shorthand for `{path:"a.b"}` |
| `{const: value}` | a literal constant |
| `{path: "a.b"}` / `{rename: "a.b"}` | nested lookup |
| `{string: node}` / `{number: node}` / `{boolean: node}` / `{date: node}` | coerce a resolved sub-mapping; an invalid coercion (e.g. `Number('abc')`) throws `MappingError`, never silently produces `NaN`/`"[object Object]"` |
| `{fallback: [a, b, ...]}` | first non-null/non-undefined result among the listed mappings (each option's own failure is swallowed so the chain can recover) |
| `{array: {from: "path", item: {...shape}}}` | maps `item` (itself a shape, output-key → sub-mapping) over every element of the array found at `from` |
| `{object: {key: node, ...}}` | builds an output object from a shape map |

**No eval, no `new Function`, no template engine capable of executing code** — every operation
above is one `if` branch in a closed, reviewable function.

## Limits (Part 36/98/99)

- Max nesting depth: 10.
- Max total field count processed: 300.
- Max array items processed: 500 (a payload with a larger array is rejected outright, not
  silently truncated).

All three are real, tested DoS protections — a malicious deeply-nested or huge-array payload is
rejected with `MappingError`, never allowed to exhaust memory/CPU.

## Prototype pollution (Part 37/38/97)

`__proto__`, `prototype`, and `constructor` are refused as: a path segment (in either a lookup
path or an output object key). This matters because `JSON.parse('{"__proto__":{"x":1}}')`
genuinely creates an *own* enumerable `"__proto__"` property (unlike a JS object literal, which
special-cases `__proto__` as a prototype-setter instead) — exactly the real-world attack shape a
malicious webhook payload could send. Verified directly by a test that parses such a payload and
confirms the global `Object.prototype` is never mutated.

## Path safety (Part 38)

`safeLookup()` never traverses inherited properties — every segment is checked with
`Object.prototype.hasOwnProperty.call()` before being read, so a path like
`"constructor.prototype.polluted"` cannot reach anything even before the explicit dangerous-key
rejection above triggers.

## Preview (Part 85-87)

`applyMapping()` is already a pure function with the exact same limits/protections a "preview"
caller would need — no separate, weaker preview implementation was built. No dedicated preview
API route exists yet (deferred to Phase 6D's Builder, which is the actual consumer).
