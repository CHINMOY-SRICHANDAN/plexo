import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer
} from 'node:http'
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'
import type { NetworkInterfaceInfo, ProxyConfig, ProxyStatus } from '../../shared/types'
import { proxyBalancer } from './proxyBalancer'
import { systemProxyManager } from './systemProxy'

export class ProxyServerManager {
  private httpServer: HttpServer | null = null
  private socksServer: TcpServer | null = null
  private running = false
  private httpPort = 8888
  private socksPort = 1080
  private systemProxyActive = false
  private ticker: NodeJS.Timeout | null = null
  private onTelemetryCallback: ((status: ProxyStatus) => void) | null = null

  isProxyRunning(): boolean {
    return this.running
  }

  setTelemetryCallback(cb: (status: ProxyStatus) => void): void {
    this.onTelemetryCallback = cb
  }

  async start(
    config: Partial<ProxyConfig>,
    availableInterfaces: NetworkInterfaceInfo[]
  ): Promise<ProxyStatus> {
    if (this.running) {
      await this.stop()
    }

    this.httpPort = config.httpPort || 8888
    this.socksPort = config.socksPort || 1080

    proxyBalancer.setInterfaces(availableInterfaces, config.selectedInterfaceIds)
    if (config.algorithm) {
      proxyBalancer.setAlgorithm(config.algorithm)
    }
    if (config.sessionAffinity !== undefined) {
      proxyBalancer.setSessionAffinity(config.sessionAffinity)
    }

    // 1. Start HTTP / HTTPS CONNECT Server
    await this.startHttpServer(this.httpPort)

    // 2. Start SOCKS5 Server
    await this.startSocksServer(this.socksPort)

    this.running = true

    // 3. Start Telemetry Broadcast Loop (every 500ms)
    this.ticker = setInterval(() => {
      if (!this.running) return
      const status = this.getStatus()
      this.onTelemetryCallback?.(status)
    }, 500)

    return this.getStatus()
  }

  async stop(): Promise<void> {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }

    if (this.systemProxyActive) {
      await this.setSystemProxy(false)
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve())
      })
      this.httpServer = null
    }

    if (this.socksServer) {
      await new Promise<void>((resolve) => {
        this.socksServer?.close(() => resolve())
      })
      this.socksServer = null
    }

    this.running = false
    this.onTelemetryCallback?.(this.getStatus())
  }

  async setSystemProxy(enable: boolean): Promise<boolean> {
    if (!systemProxyManager.isSupported()) return false

    if (enable) {
      await systemProxyManager.enable(this.httpPort, this.socksPort)
      this.systemProxyActive = true
    } else {
      await systemProxyManager.disable()
      this.systemProxyActive = false
    }

    this.onTelemetryCallback?.(this.getStatus())
    return this.systemProxyActive
  }

  getStatus(): ProxyStatus {
    const telemetry = proxyBalancer.tickTelemetry(0.5)

    return {
      running: this.running,
      httpPort: this.httpPort,
      socksPort: this.socksPort,
      systemProxyEnabled: this.systemProxyActive,
      activeConnections: telemetry.activeConnections,
      totalBytesUp: telemetry.totalBytesUp,
      totalBytesDown: telemetry.totalBytesDown,
      speedBytesPerSecUp: telemetry.speedBytesPerSecUp,
      speedBytesPerSecDown: telemetry.speedBytesPerSecDown,
      interfaces: telemetry.interfaces,
      recentConnections: telemetry.recentConnections
    }
  }

  private startHttpServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createHttpServer((req: IncomingMessage, res) => {
        // Forward HTTP requests (e.g. GET http://example.com/test)
        this.handleStandardHttp(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' })
            res.end(`Bad Gateway: ${err.message}`)
          }
        })
      })

      // Intercept HTTPS CONNECT tunneling (used by Steam, browsers, TLS clients)
      server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
        this.handleHttpsConnect(req, clientSocket, head).catch((err) => {
          console.warn('[ProxyServer] HTTP CONNECT failed:', err.message)
          clientSocket.destroy()
        })
      })

      server.on('error', (err) => {
        console.error('[ProxyServer] HTTP Server error:', err)
        reject(err)
      })

      server.listen(port, '127.0.0.1', () => {
        this.httpServer = server
        resolve()
      })
    })
  }

  private async handleHttpsConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer
  ): Promise<void> {
    const url = req.url || ''
    const [targetHost, targetPortStr] = url.split(':')
    const targetPort = targetPortStr ? parseInt(targetPortStr, 10) : 443

    if (!targetHost) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      clientSocket.destroy()
      return
    }

    try {
      const outbound = await proxyBalancer.connectToTarget(targetHost, targetPort, 'HTTPS_CONNECT')
      const { socket: upstreamSocket, release, recordBytes } = outbound

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

      if (head && head.length > 0) {
        upstreamSocket.write(head)
        recordBytes(head.length, 0)
      }

      this.pipeBidirectional(clientSocket, upstreamSocket, recordBytes, release)
    } catch {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      clientSocket.destroy()
    }
  }

  private async handleStandardHttp(
    req: IncomingMessage,
    res: import('node:http').ServerResponse
  ): Promise<void> {
    const reqUrl = req.url
    if (!reqUrl) {
      res.writeHead(400)
      res.end('Missing URL')
      return
    }

    let urlObj: URL
    try {
      urlObj = new URL(reqUrl)
    } catch {
      res.writeHead(400)
      res.end('Invalid URL in proxy request')
      return
    }

    const host = urlObj.hostname
    const port = Number(urlObj.port) || (urlObj.protocol === 'https:' ? 443 : 80)

    const outbound = await proxyBalancer.connectToTarget(host, port, 'HTTP')
    const { socket: upstreamSocket, release, recordBytes } = outbound

    // Construct raw HTTP request to upstream
    const path = urlObj.pathname + urlObj.search
    let rawHeaders = `${req.method} ${path} HTTP/1.1\r\n`
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i]
      const val = req.rawHeaders[i + 1]
      if (key.toLowerCase() === 'proxy-connection') continue
      rawHeaders += `${key}: ${val}\r\n`
    }
    rawHeaders += '\r\n'

    const headerBuf = Buffer.from(rawHeaders, 'utf-8')
    upstreamSocket.write(headerBuf)
    recordBytes(headerBuf.length, 0)

    req.on('data', (chunk: Buffer) => {
      recordBytes(chunk.length, 0)
      upstreamSocket.write(chunk)
    })

    req.on('end', () => {
      upstreamSocket.end()
    })

    upstreamSocket.on('data', (chunk: Buffer) => {
      recordBytes(0, chunk.length)
      res.write(chunk)
    })

    upstreamSocket.on('end', () => {
      res.end()
      release()
    })

    upstreamSocket.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502)
        res.end(`Upstream error: ${err.message}`)
      }
      release()
    })
  }

  private startSocksServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createTcpServer((clientSocket: Socket) => {
        this.handleSocksClient(clientSocket).catch((err) => {
          console.warn('[ProxyServer] SOCKS5 connection error:', err.message)
          clientSocket.destroy()
        })
      })

      server.on('error', (err) => {
        console.error('[ProxyServer] SOCKS Server error:', err)
        reject(err)
      })

      server.listen(port, '127.0.0.1', () => {
        this.socksServer = server
        resolve()
      })
    })
  }

  private async handleSocksClient(clientSocket: Socket): Promise<void> {
    clientSocket.once('data', (handshakeBuf: Buffer) => {
      // 1. Verify SOCKS5 (0x05)
      if (handshakeBuf.length < 2 || handshakeBuf[0] !== 0x05) {
        clientSocket.destroy()
        return
      }

      // 2. Respond with No Authentication Required (0x05 0x00)
      clientSocket.write(Buffer.from([0x05, 0x00]))

      // 3. Await CONNECT Command Request
      clientSocket.once('data', async (reqBuf: Buffer) => {
        if (reqBuf.length < 4 || reqBuf[0] !== 0x05 || reqBuf[1] !== 0x01) {
          // Command not supported or not 0x01 (CONNECT)
          clientSocket.write(
            Buffer.from([0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
          )
          clientSocket.destroy()
          return
        }

        const atyp = reqBuf[3]
        let targetHost = ''
        let targetPort = 0
        let offset = 4

        try {
          if (atyp === 0x01) {
            // IPv4: 4 bytes
            targetHost = `${reqBuf[offset]}.${reqBuf[offset + 1]}.${reqBuf[offset + 2]}.${reqBuf[offset + 3]}`
            offset += 4
          } else if (atyp === 0x03) {
            // Domain Name: 1-byte length followed by string
            const domainLen = reqBuf[offset]
            offset += 1
            targetHost = reqBuf.subarray(offset, offset + domainLen).toString('utf-8')
            offset += domainLen
          } else if (atyp === 0x04) {
            // IPv6: 16 bytes
            targetHost = reqBuf.subarray(offset, offset + 16).toString('hex')
            offset += 16
          } else {
            throw new Error(`Unsupported address type: ${atyp}`)
          }

          targetPort = reqBuf.readUInt16BE(offset)

          const outbound = await proxyBalancer.connectToTarget(targetHost, targetPort, 'SOCKS5')
          const { socket: upstreamSocket, release, recordBytes } = outbound

          // Success reply (0x05 0x00 0x00 0x01 bound_ip:bound_port)
          const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
          clientSocket.write(reply)

          this.pipeBidirectional(clientSocket, upstreamSocket, recordBytes, release)
        } catch {
          // Host unreachable (0x04) or general failure (0x01)
          clientSocket.write(
            Buffer.from([0x05, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
          )
          clientSocket.destroy()
        }
      })
    })
  }

  private pipeBidirectional(
    client: Socket,
    upstream: Socket,
    recordBytes: (up: number, down: number) => void,
    release: () => void
  ): void {
    let closed = false
    const cleanup = (): void => {
      if (closed) return
      closed = true
      release()
      client.destroy()
      upstream.destroy()
    }

    client.on('data', (chunk: Buffer) => {
      recordBytes(chunk.length, 0)
      if (!upstream.destroyed) {
        upstream.write(chunk)
      }
    })

    upstream.on('data', (chunk: Buffer) => {
      recordBytes(0, chunk.length)
      if (!client.destroyed) {
        client.write(chunk)
      }
    })

    client.on('error', cleanup)
    client.on('close', cleanup)
    upstream.on('error', cleanup)
    upstream.on('close', cleanup)
  }
}

export const proxyServerManager = new ProxyServerManager()
