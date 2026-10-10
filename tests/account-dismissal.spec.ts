/**
 * Removing a DESKTOP-SCANNED account must actually remove it.
 *
 * The reported defect: an account discovered from the WorkBuddy desktop app
 * could not be removed from the list — the row came back. `removeAccount`
 * deleted the vault entry and reported `true`, but the account is also a
 * DESKTOP sign-in, and `readAll` merges desktop scans INTO the vault
 * (`syncVault` writes back every desktop account it finds) before returning
 * the list. So the next read recreated the file that had just been deleted.
 *
 * These tests pin the fix on both halves: the account stays gone, and the
 * desktop app's own auth file is still untouched (the plugin never signs the
 * app out — the card says so, and this is what makes that true).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyCredentialStore } from '../src/auth.ts'

describe('a desktop-scanned account can be removed', () => {
  let root = ''
  let authDir = ''
  let vaultDir = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-dismiss-'))
    authDir = join(root, 'auth')
    vaultDir = join(root, 'vault')
    await mkdir(authDir, { recursive: true })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  /** A desktop auth file holding one plaintext sign-in. */
  async function writeDesktop(uid: string, nickname: string): Promise<string> {
    const path = join(authDir, 'workbuddy-desktop.info')
    await writeFile(path, JSON.stringify({
      auth: {
        accessToken: `tok-${uid}`,
        refreshToken: `ref-${uid}`,
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
      },
      account: { uid, uin: `100${uid}`, nickname },
    }))
    return path
  }

  function store(): WorkBuddyCredentialStore {
    return new WorkBuddyCredentialStore({
      refresh: async (credential: unknown) => credential,
      region: 'cn',
      authDirs: [authDir],
      vaultDir,
    } as never)
  }

  it('keeps it gone after the scan that used to bring it back', async () => {
    const desktopPath = await writeDesktop('A', 'Alpha')
    const first = store()
    const before = await first.accounts()
    expect(before.map(account => account.accountName)).toEqual(['Alpha'])
    // The desktop account IS in the vault by now — `syncVault` put it there,
    // which is what makes the removal look like it worked.
    expect(await first.removeAccount(before[0]!.id)).toBe(true)
    expect(await first.accounts()).toEqual([])
    // The defect was on the NEXT read, from the merge writing it back. A fresh
    // store (a restart) scans again, so this is the case the user hit.
    expect(await store().accounts()).toEqual([])
    // The desktop file is untouched: the plugin hid the account, it did not
    // sign the app out.
    expect(JSON.parse(await readFile(desktopPath, 'utf8')).account.nickname).toBe('Alpha')
  })

  it('remembers the dismissal across a fresh store instance', async () => {
    await writeDesktop('B', 'Beta')
    const first = store()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    const dismissed = JSON.parse(await readFile(join(vaultDir, '.dismissed.json'), 'utf8'))
    expect(dismissed.accountIds).toEqual([account!.id])
    expect(await store().accounts()).toEqual([])
  })

  it('signing in again clears the dismissal', async () => {
    await writeDesktop('C', 'Gamma')
    const first = store()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    expect(await first.accounts()).toEqual([])
    // An OAuth sign-in (or an import) for the same account must bring it back:
    // otherwise removing an account would permanently block re-adding it.
    await first.addOAuthAccount({
      accessToken: 'tok-oauth',
      refreshToken: 'ref-oauth',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'C',
      uin: '100C',
      nickname: 'Gamma',
    })
    expect((await first.accounts()).map(a => a.accountName)).toEqual(['Gamma'])
    // The dismissal list itself is cleaned up, not merely outranked.
    const dismissed = JSON.parse(await readFile(join(vaultDir, '.dismissed.json'), 'utf8'))
    expect(dismissed.accountIds).toEqual([])
  })

  it('removes a desktop-only account that has no vault entry of its own', async () => {
    // The vault file is deleted before the removal, so nothing is there to
    // delete. The dismissal must still be recorded: `removed: false` describes
    // the vault, not whether the user's request was honoured.
    await writeDesktop('D', 'Delta')
    const first = store()
    const [account] = await first.accounts()
    await rm(join(vaultDir, `${account!.id}.json`), { force: true })
    expect(await first.removeAccount(account!.id)).toBe(false)
    expect(await first.accounts()).toEqual([])
  })

  it('leaves other accounts alone', async () => {
    await writeDesktop('E', 'Epsilon')
    await writeFile(join(authDir, 'workbuddy-desktop.1.info'), JSON.stringify({
      auth: {
        accessToken: 'tok-F',
        refreshToken: 'ref-F',
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
      },
      account: { uid: 'F', uin: '100F', nickname: 'Zeta' },
    }))
    const first = store()
    const before = await first.accounts()
    expect(before.length).toBe(2)
    const target = before.find(account => account.accountName === 'Epsilon')!
    await first.removeAccount(target.id)
    expect((await first.accounts()).map(a => a.accountName)).toEqual(['Zeta'])
    // The vault keeps the surviving account's entry.
    expect((await stat(join(vaultDir, before.find(a => a.accountName === 'Zeta')!.id + '.json'))).isFile()).toBe(true)
  })
})
