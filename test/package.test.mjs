import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('the package name, bundle patch, client loader id, and diagnostics agree', () => {
  const patchName = /^\s*name:\s*'([^']+)'/m.exec(read('cordis.patch.yml'))?.[1]
  assert.equal(patchName, pkg.name, 'cordis.patch.yml must insert this package by name')

  const loaderId = /\bid:\s*'([^']+)'/.exec(read('client.js'))?.[1]
  assert.equal(loaderId, pkg.name, 'the browser half must register under this package name')

  const packageName = /const PACKAGE_NAME = '([^']+)'/.exec(read('index.js'))?.[1]
  assert.equal(packageName, pkg.name, 'host diagnostics must name this package')
})

test('every path in `files` exists, so npm pack cannot ship a broken tree', () => {
  for (const entry of pkg.files) {
    if (entry.includes('*')) {
      const [dir, pattern] = entry.split('/')
      const suffix = pattern.replace('*', '')
      assert.ok(
        readdirSync(new URL(`${dir}/`, root)).some(file => file.endsWith(suffix)),
        `${entry} matched nothing`,
      )
    } else {
      assert.ok(existsSync(new URL(entry, root)), `${entry} is missing`)
    }
  }
})
