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

import {
  CLOSING_KEYWORDS,
  MAX_CLOSING_REFERENCES,
  maskExcludedRegions,
  parseClosingReferences
} from '../closingReferences'

/** Just the written references, which is what nearly every case is about. */
function raws (text: string): string[] {
  return parseClosingReferences(text).map((r) => r.raw)
}

describe('parseClosingReferences — the happy shapes', () => {
  it('reads every closing keyword, in every case', () => {
    for (const keyword of CLOSING_KEYWORDS) {
      for (const written of [keyword, keyword.toUpperCase(), keyword[0].toUpperCase() + keyword.slice(1)]) {
        const found = parseClosingReferences(`${written} #7`)
        expect(found).toHaveLength(1)
        expect(found[0].keyword).toBe(written)
        expect(found[0].number).toBe(7)
      }
    }
  })

  it('reads a project identifier as well as a number', () => {
    const found = parseClosingReferences('Fixes AGENTRA-45')
    expect(found).toEqual([
      { keyword: 'Fixes', form: 'identifier', raw: 'AGENTRA-45', identifier: 'AGENTRA-45', index: 0 }
    ])
  })

  it('reads the GH- form', () => {
    expect(raws('closes GH-321')).toEqual(['GH-321'])
    expect(parseClosingReferences('closes GH-321')[0].number).toBe(321)
  })

  it('reads several references from one description', () => {
    expect(raws('Fixes #1, fixes #2 and resolves AGENTRA-3.\nAlso closed GH-4.')).toEqual([
      '#1',
      '#2',
      'AGENTRA-3',
      'GH-4'
    ])
  })

  it('handles CRLF, which is what GitHub actually sends', () => {
    expect(raws('Fixes #1\r\n```\r\nfixes #2\r\n```\r\nresolves AGENTRA-7\r\n')).toEqual(['#1', 'AGENTRA-7'])
  })

  it('tolerates a colon and extra spacing between keyword and reference', () => {
    expect(raws('Fixes: #12')).toEqual(['#12'])
    expect(raws('Fixes   :   #12')).toEqual(['#12'])
    expect(raws('Fixes\t#12')).toEqual(['#12'])
  })

  it('collapses duplicates, keeping the first occurrence', () => {
    const found = parseClosingReferences('fixes #9. Later on, closes #9.')
    expect(found).toHaveLength(1)
    expect(found[0].keyword).toBe('fixes')
    expect(found[0].index).toBe(0)
  })

  it('reports the offset into the ORIGINAL text, past a masked region', () => {
    const text = '```\nfixes #1\n```\nfixes #2'
    const found = parseClosingReferences(text)
    expect(found).toHaveLength(1)
    expect(text.slice(found[0].index)).toBe('fixes #2')
  })
})

describe('parseClosingReferences — what must NOT match', () => {
  it('ignores a fenced code block', () => {
    expect(raws('```\nfixes #1\n```')).toEqual([])
    expect(raws('~~~ts\nfixes #1\n~~~')).toEqual([])
  })

  it('ignores an inline code span', () => {
    expect(raws('the string `fixes #1` is a literal')).toEqual([])
    expect(raws('``a ` b fixes #1``')).toEqual([])
  })

  it('does not let a stray backtick blind the rest of the description', () => {
    expect(raws("don't ` do this\nfixes #4")).toEqual(['#4'])
  })

  it('ignores a block quote', () => {
    expect(raws('> fixes #1')).toEqual([])
    expect(raws('   > fixes #1')).toEqual([])
  })

  it('ignores a `#` inside a URL', () => {
    expect(raws('see https://github.com/o/r/issues/5#issuecomment-99')).toEqual([])
    expect(raws('closes https://example.com/a#123')).toEqual([])
    expect(raws('www.example.com/x#7 fixes')).toEqual([])
  })

  it('still reads a reference on the same line AFTER a URL', () => {
    expect(raws('see https://example.com/a#123 — fixes #8')).toEqual(['#8'])
  })

  it('ignores a keyword that is not followed by a reference', () => {
    expect(raws('this closes the loop on our design')).toEqual([])
    expect(raws('fixes')).toEqual([])
    expect(raws('fixes #')).toEqual([])
    expect(raws('fixed the flaky test')).toEqual([])
  })

  it('ignores a bare reference with no keyword', () => {
    expect(raws('see #123 and AGENTRA-45')).toEqual([])
  })

  it('does not match a keyword glued to another word', () => {
    expect(raws('prefixes #1')).toEqual([])
    expect(raws('closesomething #1')).toEqual([])
  })

  it('does not read a lowercase identifier, which is ordinary prose', () => {
    // The `i` flag is deliberately absent from the identifier branch; `utf-8`
    // must not become project UTF item 8.
    expect(raws('fixes utf-8 handling')).toEqual([])
  })

  it('does not truncate a longer reference', () => {
    expect(raws('fixes #123abc')).toEqual([])
    expect(raws('fixes AGENTRA-45-2')).toEqual([])
  })
})

describe('maskExcludedRegions', () => {
  it('preserves length exactly', () => {
    for (const text of ['```\nfixes #1\n```', '`a`', '> quoted', 'https://x.example/#1 tail', 'plain']) {
      expect(maskExcludedRegions(text)).toHaveLength(text.length)
    }
  })

  it('closes an unterminated fence at end of input rather than looping', () => {
    expect(raws('```\nfixes #1')).toEqual([])
  })
})

describe('parseClosingReferences — malformed and hostile input', () => {
  it('answers empty for non-string input instead of throwing', () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol('x'), () => {}]) {
      expect(parseClosingReferences(bad as unknown)).toEqual([])
    }
  })

  it('survives exotic Unicode without shifting offsets', () => {
    // A dotted capital I is the case-folding trap: `'İ'.toLowerCase()` is TWO
    // code units, so any implementation that lowercased a copy to match
    // case-insensitively would report an offset one past the real one.
    const text = 'İ́‮😀 fixes #5'
    const found = parseClosingReferences(text)
    expect(found).toHaveLength(1)
    expect(text.slice(found[0].index)).toBe('fixes #5')
  })

  it('survives a lone surrogate', () => {
    expect(raws('\uD800 fixes #6')).toEqual(['#6'])
  })

  it('caps the number of references it returns', () => {
    const text = Array.from({ length: MAX_CLOSING_REFERENCES * 3 }, (_, i) => `fixes #${i + 1}`).join(' ')
    expect(parseClosingReferences(text)).toHaveLength(MAX_CLOSING_REFERENCES)
  })

  it('does not scan past the length cap', () => {
    const text = `${'a'.repeat(50)} fixes #1`
    expect(parseClosingReferences(text, { maxLength: 10 })).toEqual([])
  })

  it.each([
    ['keyword prefixes', 'fixe'.repeat(50_000)],
    ['unterminated fence', `\`\`\`${'\nfixes #1'.repeat(20_000)}`],
    ['backtick storm', '`'.repeat(100_000)],
    ['hash storm', '#'.repeat(100_000)],
    ['keyword then digits', `fixes #${'9'.repeat(50_000)}`],
    ['nested-looking quantifier bait', `${'fixes '.repeat(20_000)}#1`],
    ['url storm', 'https://a.example/#1 '.repeat(5_000)],
    ['newline storm', '\n'.repeat(100_000)],
    ['whitespace before reference', `fixes${' '.repeat(50_000)}#1`]
  ])('finishes promptly on %s', (_name, text) => {
    // 🔴 THE ASSERTION IS THE CLOCK. Every one of these inputs makes a
    // backtracking matcher (or a `[\s\S]*?` fence stripper) blow up
    // exponentially; a linear scanner returns in milliseconds. The generous
    // budget keeps the test honest on a loaded CI box while still failing hard
    // on a genuine blowup, which is measured in minutes rather than in a factor
    // of two.
    const started = Date.now()
    const found = parseClosingReferences(text)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(found.length).toBeLessThanOrEqual(MAX_CLOSING_REFERENCES)
  })
})
