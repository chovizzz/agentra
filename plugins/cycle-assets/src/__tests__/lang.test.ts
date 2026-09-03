import cycle, { cycleId, cycleStatusOrder } from '@hcengineering/cycle'
import { makeLocalesTest } from '@hcengineering/platform'

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

it('en and ru have the same keys', async () => {
  const en = await loadLang('en')
  const ru = await loadLang('ru')
  expect(keyPaths(ru).sort()).toEqual(keyPaths(en).sort())
})

it('every IntlString declared by the plugin has an en translation', async () => {
  const en = await loadLang('en')
  const declared = Object.keys(cycle.string)
  const translated = new Set(Object.keys(en.string ?? {}))
  const missing = declared.filter((key) => !translated.has(key))
  expect(missing).toEqual([])
})

it('every IntlString id is namespaced under the plugin id', () => {
  for (const value of Object.values(cycle.string)) {
    expect(String(value).startsWith(`${cycleId}:string:`)).toBe(true)
  }
})

// Technical Spec §3.9: Cycle is the one enum group whose stored values are
// LOWERCASE. The display text is title case in English; regressing the stored
// value to PascalCase must fail here.
it('maps every internal status value to the display text of Technical Spec §3.9', async () => {
  const en = await loadLang('en')
  const zh = await loadLang('zh')
  const expected: Record<string, [string, string, string]> = {
    planned: ['StatusPlanned', 'Planned', '已规划'],
    active: ['StatusActive', 'Active', '进行中'],
    completed: ['StatusCompleted', 'Completed', '已完成'],
    cancelled: ['StatusCancelled', 'Cancelled', '已取消']
  }
  for (const status of cycleStatusOrder) {
    expect(status).toBe(status.toLowerCase())
    const [key, enText, zhText] = expected[status]
    expect(en.string[key]).toBe(enText)
    expect(zh.string[key]).toBe(zhText)
  }
})
