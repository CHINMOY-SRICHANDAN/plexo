import { Socket } from 'node:net'
import type {
  NetworkInterfaceInfo,
  ProxyAlgorithm,
  ProxyConnectionEntry,
  ProxyInterfaceStats
} from '../../shared/types'
import { connectFrom } from '../network/deviceBinding'

interface InterfaceRuntime {
  info: NetworkInterfaceInfo
  activeConnections: number
  totalBytesUp: number
  totalBytesDown: number
  lastBytesUp: number
  lastBytesDown: number
  speedUp: number
  speedDown: number
}

export interface OutboundConnectionResult {
  socket: Socket
  iface: NetworkInterfaceInfo
  connectionId: string
  release: () => void
  recordBytes: (up: number, down: number) => void
}

export class ProxyBalancer {
  private runtimes = new Map<string, InterfaceRuntime>()
  private pool: InterfaceRuntime[] = []
  private algorithm: ProxyAlgorithm = 'round-robin'
  private sessionAffinity = true
  private affinityCache = new Map<string, { ifaceId: string; expiresAt: number }>()
  private roundRobinIndex = 0
  private recentConnections: ProxyConnectionEntry[] = []
  private connectionCounter = 0

  setInterfaces(allInterfaces: NetworkInterfaceInfo[], selectedIds?: string[]): void {
    const activeIds = new Set(
      selectedIds && selectedIds.length > 0 ? selectedIds : allInterfaces.map((i) => i.id)
    )

    // Preserve existing byte statistics for continuing interfaces
    const newRuntimes = new Map<string, InterfaceRuntime>()
    for (const iface of allInterfaces) {
      if (!activeIds.has(iface.id)) continue
      const existing = this.runtimes.get(iface.id)
      newRuntimes.set(iface.id, {
        info: iface,
        activeConnections: existing ? existing.activeConnections : 0,
        totalBytesUp: existing ? existing.totalBytesUp : 0,
        totalBytesDown: existing ? existing.totalBytesDown : 0,
        lastBytesUp: existing ? existing.lastBytesUp : 0,
        lastBytesDown: existing ? existing.lastBytesDown : 0,
        speedUp: existing ? existing.speedUp : 0,
        speedDown: existing ? existing.speedDown : 0
      })
    }

    this.runtimes = newRuntimes
    this.pool = Array.from(newRuntimes.values())
  }

  setAlgorithm(algorithm: ProxyAlgorithm): void {
    this.algorithm = algorithm
  }

  setSessionAffinity(enabled: boolean): void {
    this.sessionAffinity = enabled
  }

  getPoolSize(): number {
    return this.pool.length
  }

  private pickInterface(targetHost: string): InterfaceRuntime | null {
    if (this.pool.length === 0) return null
    if (this.pool.length === 1) return this.pool[0]

    const now = Date.now()

    // 1. Session Affinity: Return cached interface if still active
    if (this.sessionAffinity) {
      const cached = this.affinityCache.get(targetHost)
      if (cached && cached.expiresAt > now) {
        const found = this.runtimes.get(cached.ifaceId)
        if (found) {
          cached.expiresAt = now + 10 * 60 * 1000 // refresh 10 min
          return found
        }
      }
    }

    // 2. Load-balancing algorithm
    let selected: InterfaceRuntime
    if (this.algorithm === 'least-connections') {
      selected = this.pool.reduce((prev, curr) =>
        curr.activeConnections < prev.activeConnections ? curr : prev
      )
    } else if (this.algorithm === 'ip-hash') {
      let hash = 0
      for (let i = 0; i < targetHost.length; i++) {
        hash = (hash << 5) - hash + targetHost.charCodeAt(i)
        hash |= 0
      }
      const index = Math.abs(hash) % this.pool.length
      selected = this.pool[index]
    } else {
      // Default: Round-Robin
      this.roundRobinIndex = (this.roundRobinIndex + 1) % this.pool.length
      selected = this.pool[this.roundRobinIndex]
    }

    if (this.sessionAffinity) {
      this.affinityCache.set(targetHost, {
        ifaceId: selected.info.id,
        expiresAt: now + 10 * 60 * 1000
      })
    }

    return selected
  }

  async connectToTarget(
    targetHost: string,
    targetPort: number,
    protocol: 'HTTP' | 'HTTPS_CONNECT' | 'SOCKS5' = 'HTTPS_CONNECT'
  ): Promise<OutboundConnectionResult> {
    if (this.pool.length === 0) {
      throw new Error('No network interfaces are configured or available in Plexo Proxy')
    }

    const primaryChoice = this.pickInterface(targetHost)
    if (!primaryChoice) {
      throw new Error('No active network interface candidate')
    }

    // Attempt candidates starting with primaryChoice, falling back to other interfaces
    const candidates = [primaryChoice, ...this.pool.filter((rt) => rt !== primaryChoice)]

    let lastError: Error | null = null

    for (const candidate of candidates) {
      try {
        const socket = await this.attemptConnection(candidate.info.address, targetHost, targetPort)

        const connId = `px-conn-${++this.connectionCounter}`
        candidate.activeConnections++

        const connectionEntry: ProxyConnectionEntry = {
          id: connId,
          targetHost,
          targetPort,
          protocol,
          interfaceId: candidate.info.id,
          interfaceLabel: candidate.info.displayName,
          interfaceKind: candidate.info.kind,
          bytesUp: 0,
          bytesDown: 0,
          speedBytesPerSec: 0,
          startedAt: Date.now()
        }

        this.recentConnections.unshift(connectionEntry)
        if (this.recentConnections.length > 30) {
          this.recentConnections.pop()
        }

        let released = false
        const release = (): void => {
          if (released) return
          released = true
          candidate.activeConnections = Math.max(0, candidate.activeConnections - 1)
        }

        const recordBytes = (up: number, down: number): void => {
          candidate.totalBytesUp += up
          candidate.totalBytesDown += down
          connectionEntry.bytesUp += up
          connectionEntry.bytesDown += down
        }

        return {
          socket,
          iface: candidate.info,
          connectionId: connId,
          release,
          recordBytes
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        console.warn(
          `[ProxyBalancer] Connection to ${targetHost}:${targetPort} failed on ${candidate.info.displayName} (${candidate.info.address}), trying fallback:`,
          lastError.message
        )
      }
    }

    throw lastError || new Error(`Failed to connect to ${targetHost}:${targetPort}`)
  }

  private attemptConnection(
    localAddress: string,
    targetHost: string,
    targetPort: number
  ): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let resolved = false
      const socket = connectFrom(localAddress, targetHost, targetPort)

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          socket.destroy()
          reject(new Error(`Connection timeout to ${targetHost}:${targetPort}`))
        }
      }, 10000)

      socket.once('connect', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          resolve(socket)
        }
      })

      socket.once('error', (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(err)
        }
      })
    })
  }

  tickTelemetry(elapsedSec = 1): {
    totalBytesUp: number
    totalBytesDown: number
    speedBytesPerSecUp: number
    speedBytesPerSecDown: number
    activeConnections: number
    interfaces: ProxyInterfaceStats[]
    recentConnections: ProxyConnectionEntry[]
  } {
    let totalBytesUp = 0
    let totalBytesDown = 0
    let totalSpeedUp = 0
    let totalSpeedDown = 0
    let totalActiveConnections = 0

    const ifaceStats: ProxyInterfaceStats[] = []

    for (const rt of this.pool) {
      const deltaUp = Math.max(0, rt.totalBytesUp - rt.lastBytesUp)
      const deltaDown = Math.max(0, rt.totalBytesDown - rt.lastBytesDown)
      rt.lastBytesUp = rt.totalBytesUp
      rt.lastBytesDown = rt.totalBytesDown

      rt.speedUp = elapsedSec > 0 ? Math.round(deltaUp / elapsedSec) : 0
      rt.speedDown = elapsedSec > 0 ? Math.round(deltaDown / elapsedSec) : 0

      totalBytesUp += rt.totalBytesUp
      totalBytesDown += rt.totalBytesDown
      totalSpeedUp += rt.speedUp
      totalSpeedDown += rt.speedDown
      totalActiveConnections += rt.activeConnections

      ifaceStats.push({
        interfaceId: rt.info.id,
        interfaceLabel: rt.info.displayName,
        interfaceKind: rt.info.kind,
        address: rt.info.address,
        bytesUp: rt.totalBytesUp,
        bytesDown: rt.totalBytesDown,
        speedBytesPerSecUp: rt.speedUp,
        speedBytesPerSecDown: rt.speedDown,
        activeConnections: rt.activeConnections
      })
    }

    return {
      totalBytesUp,
      totalBytesDown,
      speedBytesPerSecUp: totalSpeedUp,
      speedBytesPerSecDown: totalSpeedDown,
      activeConnections: totalActiveConnections,
      interfaces: ifaceStats,
      recentConnections: [...this.recentConnections]
    }
  }
}

export const proxyBalancer = new ProxyBalancer()
