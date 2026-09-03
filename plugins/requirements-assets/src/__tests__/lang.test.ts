import { makeLocalesTest } from '@hcengineering/platform'
import requirements, { requirementsId, requirementStatusOrder } from '@hcengineering/requirements'

async function loadLang (lang: string): Promise<Record<string, any>> {
  const mod: Record<string, any> = await import(`../../lang/${lang}.json`)
  return mod.default ?? mod
}

function keyPaths (obj: Record<string, any>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : keyPaths(value, `${prefix}${key}.`)
  )
}

// `makeLocalesTest` hard codes `const langs = ['en', 'ru']`
// (foundations/core/packages/platform/src/testUtils.ts). Shipping only en + zh
// would make this very import fail, which is why `ru.json` exists.
it(
  'Locales are equale',
  makeLocalesTest(async (lang) => await import(`../../lang/${lang}.json`))
)

it('en and zh have the same keys', async () => {
  const en = await loadLang('en')
  const zh = await loadLang('zh')
  expect(keyPaths(zh).sort()).toEqual(keyPaths(en).sort())
})

it('every IntlString declared by the plugin has an en translation', async () => {
  const en = await loadLang('en')
  const declared = Object.keys(requirements.string)
  const translated = new Set(Object.keys(en.string ?? {}))
  const missing = declared.filter((key) => !translated.has(key))
  expect(missing).toEqual([])
})

it('every IntlString id is namespaced under the plugin id', () => {
  for (const value of Object.values(requirements.string)) {
    expect(String(value).startsWith(`${requirementsId}:string:`)).toBe(true)
  }
})

// Technical Spec §3.9: the internal enum value is PascalCase without spaces and
// the English display text is space separated. `InDelivery` -> `In Delivery` is
// the one pair where the two actually differ, so it is the one that regresses.
it('maps every internal status value to the display text of Technical Spec §3.9', async () => {
  const en = await loadLang('en')
  const zh = await loadLang('zh')
  const expected: Record<string, [string, string]> = {
    Draft: ['Draft', '草稿'],
    Reviewing: ['Reviewing', '评审中'],
    Approved: ['Approved', '已批准'],
    InDelivery: ['In Delivery', '交付中'],
    Validating: ['Validating', '验证中'],
    Released: ['Released', '已发布'],
    Rejected: ['Rejected', '已驳回'],
    Cancelled: ['Cancelled', '已取消']
  }
  for (const status of requirementStatusOrder) {
    const [enText, zhText] = expected[status]
    expect(en.string[`Status${status}`]).toBe(enText)
    expect(zh.string[`Status${status}`]).toBe(zhText)
  }
})
