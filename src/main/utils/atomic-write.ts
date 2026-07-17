import fsp from 'node:fs/promises'
import path from 'node:path'

const RENAME_MAX_RETRIES = 5
const RENAME_RETRY_DELAY_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function renameWithRetry(src: string, dest: string, attempt = 0): Promise<void> {
  try {
    await fsp.rename(src, dest)
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < RENAME_MAX_RETRIES) {
      await delay(RENAME_RETRY_DELAY_MS * (attempt + 1))
      return renameWithRetry(src, dest, attempt + 1)
    }
    throw err
  }
}

export async function atomicWrite(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf-8',
): Promise<void> {
  const dir = path.dirname(filePath)
  await fsp.mkdir(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  try {
    await fsp.writeFile(tmpPath, data, typeof data === 'string' ? encoding : undefined)
  } catch (writeErr) {
    if (writeErr instanceof Error && (writeErr as NodeJS.ErrnoException).code === 'ENOENT') {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(tmpPath, data, typeof data === 'string' ? encoding : undefined)
    } else {
      throw writeErr
    }
  }
  await renameWithRetry(tmpPath, filePath)
  fsp.unlink(tmpPath).catch(() => {})
}
