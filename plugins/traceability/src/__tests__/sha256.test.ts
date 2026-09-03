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

import { createHash } from 'crypto'

import { sha256Hex } from '../sha256'

describe('sha256Hex', () => {
  // Published NIST/RFC test vectors. These pin the implementation to real
  // SHA-256, so a subtle arithmetic regression cannot pass by merely being
  // self-consistent.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
    ]
  ])('hashes %p correctly', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })

  it('matches node crypto across block-boundary lengths', () => {
    // 55/56/63/64/119/120 are the padding edge cases where a naive
    // implementation adds or drops a block.
    for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 200]) {
      const input = 'a'.repeat(len)
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input).digest('hex'))
    }
  })

  it('matches node crypto for multi-byte utf-8 and astral characters', () => {
    for (const input of ['需求追溯', 'Трассируемость', '🚀 trace 🔗', 'a b']) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'))
    }
  })

  it('always returns 64 lowercase hex chars', () => {
    for (let i = 0; i < 200; i++) {
      expect(sha256Hex(`input-${i}`)).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
