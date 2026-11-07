import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The staff app's checkout, beside this repo. Most of the money tests run its functions, so a
 * missing folder fails the suite: skipping them would leave a green run that proved nothing.
 */
export function staffAppDir(): string {
  const dir = process.env.RETOOL_APP_DIR ?? path.resolve(__dirname, '../../../../../paddock-retool-app')
  if (!existsSync(path.join(dir, 'backend/paddock'))) {
    throw new Error(`The staff app's checkout isn't at ${dir}. Set RETOOL_APP_DIR, or put it beside this repo: the money tests can't run without it.`)
  }
  return dir
}
