/**
 * scripts/lib/frontmatter.ts
 *
 * Flat YAML frontmatter helpers shared across the watcher modules.
 *
 * Originally defined inline in `scripts/inbound-watcher.ts` (= bd
 * ccsc-9hm onwards). Extracted to `scripts/lib/` per Codex review on
 * PR #10 (bd ccsc-a04) so downstream modules — notably
 * `scripts/lib/project-channel-registry.ts` — can parse queue files
 * without depending on `inbound-watcher.ts`. Phase 2B/2C will then
 * import the loader from inbound-watcher without re-introducing the
 * cycle that would have formed if the loader still pointed at
 * `../inbound-watcher`.
 *
 * The format intentionally stays minimal: one `key: value` per line,
 * double-quoted strings with `\\`/`\"`/`\n`/`\r` escapes, bare
 * numbers, bare `null`. Lists, nested maps, anchors, multi-line
 * scalars are NOT supported. Since the watcher and its peers control
 * both ends of the file format, this avoids a YAML dependency.
 *
 * No behavior change vs. the previous inline implementation —
 * `inbound-watcher.ts` re-exports the same symbols, so existing
 * importers (executor-relay, outbox, the test file) continue to
 * resolve them unchanged.
 */

export type FrontmatterValue = string | number | null
export type Frontmatter = Record<string, FrontmatterValue>

/**
 * Escape a string for the double-quoted YAML scalar form we emit.
 * Order matters: backslash MUST be escaped first so the backslash
 * introduced by subsequent escapes (`\"`, `\n`, `\r`) is not
 * re-escaped.
 */
export function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

/**
 * Inverse of escapeYamlString. Single-pass to avoid the order trap of
 * a multi-replace pipeline (the prior multi-replace would corrupt a
 * literal `\n` (= backslash + n in the source string) by treating it
 * as an escape after the leading backslash had already been doubled).
 *
 * Recognized escapes: `\\\\` -> `\`, `\\"` -> `"`, `\\n` -> newline,
 * `\\r` -> CR. Unknown escapes (`\\x`) are passed through verbatim
 * (= `\\x` stays `\\x` in the decoded string), so an unrecognized
 * escape never silently loses the leading backslash.
 */
export function unescapeYamlString(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1]
      if (next === '\\') out += '\\'
      else if (next === '"') out += '"'
      else if (next === 'n') out += '\n'
      else if (next === 'r') out += '\r'
      else out += `\\${next}` // unknown escape: keep verbatim (no silent drop)
      i += 2
    } else {
      out += s[i]
      i++
    }
  }
  return out
}

/**
 * Serialize a flat key/value map to YAML-ish frontmatter (one line per
 * key, double-quoted strings with backslash escapes for `\`, `"`,
 * `\n`, `\r`). Numbers and `null` are emitted bare.
 *
 * Intentionally minimal — the watcher controls both ends, so we don't
 * pull a YAML lib for nested structures we don't use.
 */
export function serializeFrontmatter(fm: Frontmatter): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(fm)) {
    if (v === null) {
      lines.push(`${k}: null`)
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`)
    } else {
      lines.push(`${k}: "${escapeYamlString(v)}"`)
    }
  }
  return lines.join('\n')
}

/**
 * Parse a `---\n<frontmatter>\n---\n<body>` file. Mirrors the shape
 * serializeFrontmatter() emits. Unknown YAML constructs (lists, nested
 * maps) are not supported by design.
 */
export function parseFrontmatterFile(content: string): { fm: Frontmatter; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content)
  if (!m) return null
  const fm: Frontmatter = {}
  for (const line of m[1].split('\n')) {
    const lineMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!lineMatch) continue
    const k = lineMatch[1]
    const raw = lineMatch[2].trim()
    if (raw === 'null') {
      fm[k] = null
    } else if (/^-?\d+$/.test(raw)) {
      fm[k] = Number.parseInt(raw, 10)
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      fm[k] = unescapeYamlString(raw.slice(1, -1))
    } else {
      fm[k] = raw
    }
  }
  return { fm, body: m[2] ?? '' }
}
