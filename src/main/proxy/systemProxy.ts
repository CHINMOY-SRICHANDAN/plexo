import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class SystemProxyManager {
  private originalState: { enabled: boolean; server?: string } | null = null

  isSupported(): boolean {
    return process.platform === 'win32'
  }

  async getProxyStatus(): Promise<{ enabled: boolean; server: string }> {
    if (!this.isSupported()) return { enabled: false, server: '' }

    try {
      const { stdout } = await execFileAsync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable'
      ])
      const match = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(stdout)
      const enabled = match ? parseInt(match[1], 16) === 1 : false

      let server = ''
      try {
        const { stdout: serverOut } = await execFileAsync('reg', [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
          '/v',
          'ProxyServer'
        ])
        const serverMatch = /ProxyServer\s+REG_SZ\s+(.+)/.exec(serverOut)
        if (serverMatch) server = serverMatch[1].trim()
      } catch {
        // no server set
      }

      return { enabled, server }
    } catch {
      return { enabled: false, server: '' }
    }
  }

  async enable(httpPort = 8888, socksPort = 1080): Promise<void> {
    if (!this.isSupported()) return

    const current = await this.getProxyStatus()
    if (!this.originalState) {
      this.originalState = current
    }

    const proxyString = `http=127.0.0.1:${httpPort};https=127.0.0.1:${httpPort};socks=127.0.0.1:${socksPort}`

    await execFileAsync('reg', [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyEnable',
      '/t',
      'REG_DWORD',
      '/d',
      '1',
      '/f'
    ])

    await execFileAsync('reg', [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyServer',
      '/t',
      'REG_SZ',
      '/d',
      proxyString,
      '/f'
    ])

    await execFileAsync('reg', [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyOverride',
      '/t',
      'REG_SZ',
      '/d',
      '<local>;localhost;127.*',
      '/f'
    ])

    await this.notifyWinInet()
  }

  async disable(): Promise<void> {
    if (!this.isSupported()) return

    try {
      await execFileAsync('reg', [
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
        '/t',
        'REG_DWORD',
        '/d',
        '0',
        '/f'
      ])
      await this.notifyWinInet()
    } catch (err) {
      console.warn('[SystemProxy] Failed to disable system proxy:', err)
    }
  }

  /**
   * WinINet caches proxy settings per process. Invoking InternetSetOption forces
   * Windows to reload the updated registry settings immediately.
   */
  private async notifyWinInet(): Promise<void> {
    if (process.platform !== 'win32') return
    try {
      const script = `
        $code = @'
        [System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError = true)]
        public static extern bool InternetSetOption(System.IntPtr hInternet, int dwOption, System.IntPtr lpBuffer, int dwBufferLength);
'@
        $wininet = Add-Type -MemberDefinition $code -Name "WinINetHelper" -Namespace "Plexo" -PassThru
        $wininet::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0) | Out-Null
        $wininet::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0) | Out-Null
      `
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 4000
      })
    } catch {
      // Ignored if PowerShell pin fails; registry is already updated.
    }
  }
}

export const systemProxyManager = new SystemProxyManager()
