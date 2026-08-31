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

it(
  'Locales are equale',
  makeLocalesTest(async (lang) => await import(`../../lang/${lang}.json`))
)

it('en and zh have the same keys', async () => {
  const en = await loadLang('en')
  const zh = await loadLang('zh')
  expect(keyPaths(zh).sort()).toEqual(keyPaths(en).sort())
})
