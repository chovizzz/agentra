import crmLite, { crmLiteId } from '@hcengineering/crm-lite'
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

it('every IntlString declared by the plugin has an en translation', async () => {
  const en = await loadLang('en')
  const declared = Object.keys(crmLite.string)
  const translated = new Set(Object.keys(en.string ?? {}))
  const missing = declared.filter((key) => !translated.has(key))
  expect(missing).toEqual([])
})

it('every IntlString id is namespaced under the plugin id', () => {
  for (const value of Object.values(crmLite.string)) {
    expect(String(value).startsWith(`${crmLiteId}:string:`)).toBe(true)
  }
})
