//
// Copyright © 2026 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

/**
 * Parsing of GitHub "closing references" out of a pull request description.
 *
 * 🔴 THIS FILE PARSES HOSTILE INPUT. A PR body is written by anyone who can open
 * a pull request, including a drive-by contributor on a public repository. Every
 * defence here — the length cap, the result cap, the bounded quantifiers, the
 * single linear masking pass — exists because the caller is a webhook handler
 * that must not be turned into a denial of service by a crafted description.
 *
 * 🔴 NO UNBOUNDED QUANTIFIER FOLLOWS ANOTHER QUANTIFIER anywhere in
 * {@link CLOSING_REFERENCE_RE}. Every repetition is `{0,n}` or `{1,n}` with a
 * small literal `n`, and the alternation branches are mutually exclusive on
 * their first character, so the matcher is linear in the input and cannot
 * backtrack catastrophically. Adding a `+` or a `*` to this pattern reopens
 * that hole; do not.
 *
 * 🔴 CODE, QUOTES AND URLS ARE MASKED BEFORE MATCHING, not filtered afterwards.
 * The masking pass ({@link maskExcludedRegions}) is a hand written single pass
 * that replaces every excluded region with spaces of the SAME LENGTH, so the
 * offsets reported in {@link ClosingReference.index} still address the original
 * text. A "strip then match" implementation would report offsets into a string
 * the caller never saw.
 */

/**
 * The GitHub closing keywords, in every form GitHub itself accepts.
 *
 * Source of truth is GitHub's "Linking a pull request to an issue" doc: three
 * verbs, each in base / -s / -d form. Matching is case insensitive.
 *
 * ⚠️ ORDER MATTERS INSIDE THE ALTERNATION that is built from this list. A
 * regular expression alternation is FIRST MATCH WINS, not longest match, so
 * `close` placed before `closes` would match the first five characters of
 * "closes" and leave the trailing `s` to be matched as the start of the
 * reference — which then fails. The alternation is therefore built
 * longest-first by {@link buildKeywordAlternation}, so the literal order of
 * this array is presentational only.
 *
 * @public
 */
export const CLOSING_KEYWORDS: readonly string[] = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved'
] as const

/**
 * Hard cap on how much of a description is examined.
 *
 * 🔴 A CAP, NOT A GUARD. The scan is linear, so a long body is slow rather than
 * catastrophic — but "linear over ten megabytes" still blocks the event loop of
 * a webhook handler for a noticeable time, and a closing reference that far into
 * a description is not a real one. Text beyond this point is not scanned and
 * therefore yields no references.
 *
 * @public
 */
export const MAX_DESCRIPTION_LENGTH = 100_000

/**
 * Hard cap on how many references one description may yield.
 *
 * 🔴 THE REAL DENIAL-OF-SERVICE VECTOR IS DOWNSTREAM, NOT HERE. Each returned
 * reference becomes a document read and possibly a trace edge write; a body
 * containing fifty thousand `fixes #1 fixes #2 …` costs almost nothing to parse
 * and a great deal to act on. The cap belongs in the parser because the parser
 * is the only place that sees the whole list.
 *
 * ⚠️ Deduplication happens BEFORE the cap is applied, so a description that
 * repeats one reference ten thousand times is not truncated to a single
 * distinct value.
 *
 * @public
 */
export const MAX_CLOSING_REFERENCES = 100

/**
 * How a reference named its target.
 *
 * @public
 */
export type ClosingReferenceForm = 'number' | 'identifier'

/**
 * One closing reference found in a description.
 *
 * 🔴 NOT A `Ref`. Resolving `#123` or `AGENTRA-45` onto a concrete document
 * needs a repository binding and a tracker query, neither of which belongs in
 * this package. The parser reports what was written; the caller resolves it.
 *
 * @public
 */
export interface ClosingReference {
  /** The keyword exactly as written, e.g. `Fixes`. */
  keyword: string
  form: ClosingReferenceForm
  /** The reference exactly as written, e.g. `#123` or `AGENTRA-45`. */
  raw: string
  /** Set when `form === 'number'`; the issue number without the `#`. */
  number?: number
  /** Set when `form === 'identifier'`; the identifier as written, e.g. `AGENTRA-45`. */
  identifier?: string
  /** Offset of the keyword in the ORIGINAL text. */
  index: number
}

/**
 * @public
 */
export interface ParseClosingReferencesOptions {
  maxLength?: number
  maxReferences?: number
}

/** `close` -> `[Cc][Ll][Oo][Ss][Ee]`. */
function caseInsensitiveLiteral (word: string): string {
  let out = ''
  for (const ch of word) {
    out += `[${ch.toUpperCase()}${ch.toLowerCase()}]`
  }
  return out
}

/**
 * Build the keyword alternation, LONGEST FIRST.
 *
 * 🔴 See the warning on {@link CLOSING_KEYWORDS}: alternation is first-match,
 * so `fix` ahead of `fixes` would swallow the verb and strand the `es`.
 */
function buildKeywordAlternation (): string {
  return [...CLOSING_KEYWORDS]
    .sort((a, b) => (b.length !== a.length ? b.length - a.length : a.localeCompare(b)))
    .map(caseInsensitiveLiteral)
    .join('|')
}

/**
 * The matcher.
 *
 * 🔴 CASE INSENSITIVITY IS SPELLED OUT PER LETTER INSTEAD OF USING THE `i` FLAG,
 * and that is load bearing twice over.
 *
 * 1. The `i` flag would apply to the IDENTIFIER branch too, so `fixes utf-8`
 *    would be read as a reference to project `UTF` item 8. Huly identifiers are
 *    uppercase (`Issue.identifier`, e.g. `AGE-1`), so demanding uppercase is the
 *    cheap way to keep ordinary prose out.
 * 2. `String.prototype.toLowerCase` is NOT length preserving in Unicode
 *    (`'İ'.toLowerCase()` is two code units), so the obvious alternative —
 *    lowercase a copy and match against that — would silently shift every
 *    reported offset on input containing a dotted capital I. Masking preserves
 *    length; case folding does not.
 *
 * 🔴 EVERY QUANTIFIER IS BOUNDED. `[ \t]{0,8}` twice with an optional colon
 * between them covers `fixes #1`, `fixes: #1` and `Fixes   :  #1` without ever
 * admitting a nested repetition.
 *
 * ⚠️ ONE KEYWORD, ONE REFERENCE — the same rule GitHub itself applies. `fixes
 * #1, #2` closes only #1 on GitHub, and reading the list form here would create
 * edges GitHub never made. Multiple references in one description are written
 * as multiple keywords (`fixes #1, fixes #2`), and that form IS supported.
 *
 * ⚠️ `owner/repo#123` IS DELIBERATELY NOT SUPPORTED. Admitting a `/` before the
 * `#` is exactly what makes a URL fragment (`…/issues/5#issuecomment-99`) look
 * like a reference, and cross-repository closing references are not reachable
 * from a single-workspace tracker anyway. See the leftover note in the module
 * doc of the command.
 */
const CLOSING_REFERENCE_RE = new RegExp(
  `\\b(${buildKeywordAlternation()})\\b[ \\t]{0,8}:?[ \\t]{0,8}` +
    '(?:#(\\d{1,9})|[Gg][Hh]-(\\d{1,9})|([A-Z][A-Z0-9]{1,14}-\\d{1,9}))(?![\\w-])',
  'g'
)

const SPACES = '                                                                '

/** `n` spaces, without a loop that a hostile length could make quadratic. */
function spaces (n: number): string {
  let out = ''
  let left = n
  while (left >= SPACES.length) {
    out += SPACES
    left -= SPACES.length
  }
  return out + SPACES.slice(0, left)
}

function isFenceLine (line: string): string | undefined {
  // Up to three leading spaces, then three or more backticks or tildes.
  let i = 0
  while (i < 3 && line.charAt(i) === ' ') i++
  const ch = line.charAt(i)
  if (ch !== '`' && ch !== '~') return undefined
  let n = 0
  while (line.charAt(i + n) === ch) n++
  return n >= 3 ? ch : undefined
}

function isQuoteLine (line: string): boolean {
  let i = 0
  while (i < 3 && line.charAt(i) === ' ') i++
  return line.charAt(i) === '>'
}

function isUrlStart (line: string, i: number): boolean {
  // Only at a boundary, so `xhttp://` is not a URL.
  if (i > 0 && /[\w-]/.test(line.charAt(i - 1))) return false
  const rest = line.slice(i, i + 8)
  return /^https?:\/\//.test(rest) || /^www\./.test(rest)
}

/**
 * Replace every region a closing reference may NOT appear in with spaces.
 *
 * 🔴 SINGLE PASS, LENGTH PRESERVING, NO REGULAR EXPRESSION OVER THE WHOLE
 * DOCUMENT. Masking fenced code with something like `/```[\s\S]*?```/g` is the
 * classic way to hand an attacker a quadratic blowup on unterminated fences;
 * this walks the text once and each character is examined a constant number of
 * times.
 *
 * Excluded regions:
 * - fenced code blocks (``` or ~~~), fence lines included;
 * - inline code spans, including an UNTERMINATED one, which is masked to the
 *   end of its line rather than to the end of the document — a stray backtick
 *   in prose must not blind the parser to everything after it;
 * - block quotes (`>`), which are how a description quotes somebody ELSE's text;
 * - bare URLs, so a fragment such as `…#123` is never read as a reference.
 *
 * @public
 */
export function maskExcludedRegions (text: string): string {
  const lines = text.split('\n')
  let fence: string | undefined
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const fenceChar = isFenceLine(line)
    if (fence !== undefined) {
      lines[li] = spaces(line.length)
      if (fenceChar === fence) fence = undefined
      continue
    }
    if (fenceChar !== undefined) {
      fence = fenceChar
      lines[li] = spaces(line.length)
      continue
    }
    if (isQuoteLine(line)) {
      lines[li] = spaces(line.length)
      continue
    }
    let out = ''
    let i = 0
    while (i < line.length) {
      const ch = line.charAt(i)
      if (ch === '`') {
        let open = 0
        while (line.charAt(i + open) === '`') open++
        // Look for a run of exactly the same length.
        let j = i + open
        let close = -1
        while (j < line.length) {
          if (line.charAt(j) === '`') {
            let run = 0
            while (line.charAt(j + run) === '`') run++
            if (run === open) {
              close = j + run
              break
            }
            j += run
          } else {
            j++
          }
        }
        const end = close === -1 ? line.length : close
        out += spaces(end - i)
        i = end
        continue
      }
      if (isUrlStart(line, i)) {
        let j = i
        while (j < line.length && !/\s/.test(line.charAt(j))) j++
        out += spaces(j - i)
        i = j
        continue
      }
      out += ch
      i++
    }
    lines[li] = out
  }
  return lines.join('\n')
}

/**
 * Extract the closing references from a pull request description.
 *
 * Never throws, and never returns more than {@link MAX_CLOSING_REFERENCES}
 * entries. Non-string input yields an empty list rather than an error: the
 * caller is a webhook handler and a malformed payload must not become an
 * exception on the delivery path.
 *
 * Duplicates are collapsed on `(form, value)` keeping the FIRST occurrence, so
 * `fixes #1 … fixes #1` describes one edge, not two.
 *
 * @public
 */
export function parseClosingReferences (text: unknown, options: ParseClosingReferencesOptions = {}): ClosingReference[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const maxLength = options.maxLength ?? MAX_DESCRIPTION_LENGTH
  const maxReferences = options.maxReferences ?? MAX_CLOSING_REFERENCES
  const scanned = text.length > maxLength ? text.slice(0, maxLength) : text
  const masked = maskExcludedRegions(scanned)

  const out: ClosingReference[] = []
  const seen = new Set<string>()
  // A fresh matcher per call: `lastIndex` on a shared `/g` regex is mutable
  // state, and a shared instance would make concurrent callers skip matches.
  const re = new RegExp(CLOSING_REFERENCE_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(masked)) !== null) {
    // A zero-length match cannot happen with this pattern, but a future edit
    // could introduce one and an unadvanced `lastIndex` would loop forever.
    if (match[0].length === 0) {
      re.lastIndex++
      continue
    }
    const [, keyword, hashNumber, ghNumber, identifier] = match
    const numberText = hashNumber ?? ghNumber
    const form: ClosingReferenceForm = numberText !== undefined ? 'number' : 'identifier'
    const key = form === 'number' ? `n:${numberText}` : `i:${identifier}`
    if (seen.has(key)) continue
    seen.add(key)
    if (form === 'number') {
      out.push({
        keyword,
        form,
        raw: hashNumber !== undefined ? `#${hashNumber}` : `GH-${ghNumber}`,
        number: Number(numberText),
        index: match.index
      })
    } else {
      out.push({ keyword, form, raw: identifier, identifier, index: match.index })
    }
    if (out.length >= maxReferences) break
  }
  return out
}
