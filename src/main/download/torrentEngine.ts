import { Notification } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type WebTorrent from 'webtorrent'
import type { Torrent } from 'webtorrent'
import type {
  BlockState,
  ChunkState,
  DownloadState,
  NetworkInterfaceInfo
} from '../../shared/types'

export const DEFAULT_TRACKERS = [
  // Top tier high-speed UDP trackers (Fast response, high uptime, massive swarms)
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker2.dler.org:80/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.tracker.vraphim.com:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.filemail.com:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://run.publictracker.xyz:6969/announce',
  'udp://tracker.dump.cl:6969/announce',
  'udp://tracker.altrosky.nl:6969/announce',
  'udp://retracker.lanta-net.ru:2710/announce',
  'udp://tracker.moeking.me:6969/announce',

  // High-availability HTTP trackers
  'http://tracker.openbittorrent.com:80/announce',
  'http://tracker.bt4g.com:2095/announce',
  'http://open.acgnxtracker.com:80/announce',

  // WebRTC / WSS Trackers (for WebTorrent & browser swarms)
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.fastcast.nz'
]

export interface TorrentDownloadCallbacks {
  onUpdate: (state: DownloadState) => void
  onDone: (state: DownloadState) => void
  onError: (state: DownloadState, error: Error) => void
}

export class TorrentEngine {
  private client: WebTorrent | null = null
  private activeTorrent: Torrent | null = null
  private activeState: DownloadState | null = null
  private callbacks: TorrentDownloadCallbacks | null = null
  private updateTimer: NodeJS.Timeout | null = null
  private peerSyncInterval: NodeJS.Timeout | null = null

  private async getClient(): Promise<WebTorrent> {
    if (!this.client) {
      const { default: WebTorrentClass } = await import('webtorrent')
      this.client = new WebTorrentClass({
        maxConns: 150,
        dht: true,
        lsd: true,
        tracker: {
          announce: DEFAULT_TRACKERS
        },
        utPex: true,
        natUpnp: true,
        natPmp: true,
        webSeeds: true
      })
      this.client.on('error', (err: unknown) => {
        console.error('[TorrentEngine] Client error:', err)
      })
    }
    return this.client
  }

  isTorrentActive(): boolean {
    return Boolean(this.activeTorrent && this.activeState)
  }

  getCurrentState(): DownloadState | null {
    return this.activeState ? structuredClone(this.activeState) : null
  }

  async startTorrent(
    torrentId: string | Buffer,
    destinationDir: string,
    initialState: {
      id: string
      url: string
      suggestedFileName: string
      totalBytes: number
      interfaces?: NetworkInterfaceInfo[]
      streamsPerNetwork?: number
      interfaceId?: string
      interfaceLabel?: string
    },
    callbacks: TorrentDownloadCallbacks
  ): Promise<string> {
    if (this.activeTorrent) {
      throw new Error('A torrent download is already in progress')
    }

    const client = await this.getClient()
    this.callbacks = callbacks

    // If torrentId is a local filesystem path, read it into a Buffer
    // so WebTorrent does not attempt bencode parsing on the path string.
    let finalTorrentId: string | Buffer = torrentId
    if (typeof torrentId === 'string' && !torrentId.startsWith('magnet:')) {
      if (existsSync(torrentId)) {
        try {
          finalTorrentId = await readFile(torrentId)
        } catch (err) {
          console.warn(
            '[TorrentEngine] Failed reading torrent file to buffer, using raw path:',
            err
          )
        }
      }
    }

    if (typeof finalTorrentId === 'string' && finalTorrentId.startsWith('magnet:')) {
      try {
        const { default: parseTorrent, toMagnetURI } = await import('parse-torrent')
        const parsed = await parseTorrent(finalTorrentId)
        const existing = Array.isArray(parsed.announce) ? parsed.announce : []
        parsed.announce = Array.from(new Set([...existing, ...DEFAULT_TRACKERS]))
        finalTorrentId = toMagnetURI(parsed)
      } catch {
        // keep original if parsing fails
      }
    }

    const streamsPerNetwork = Math.max(1, initialState.streamsPerNetwork || 1)
    const activeInterfaces =
      initialState.interfaces && initialState.interfaces.length > 0
        ? initialState.interfaces
        : [
            {
              id: initialState.interfaceId || 'torrent-swarm',
              displayName: initialState.interfaceLabel || 'BitTorrent Swarm',
              kind: 'other' as const
            } as NetworkInterfaceInfo
          ]

    const chunks: ChunkState[] = []
    let chunkId = 0
    for (const iface of activeInterfaces) {
      for (let s = 0; s < streamsPerNetwork; s++) {
        chunks.push({
          id: chunkId++,
          interfaceId: iface.id,
          interfaceLabel: iface.displayName,
          interfaceKind: iface.kind,
          rangeStart: 0,
          rangeEnd: null,
          bytesDownloaded: 0,
          speedBytesPerSec: 0,
          status: 'downloading',
          retryCount: 0
        })
      }
    }

    const state: DownloadState = {
      id: initialState.id,
      url: initialState.url,
      fileName: initialState.suggestedFileName,
      destinationPath: join(destinationDir, initialState.suggestedFileName),
      totalBytes: initialState.totalBytes,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: 'downloading',
      chunks,
      blocks: [],
      totalBlocks: 0,
      isTorrent: true,
      torrentPeers: 0,
      startedAt: Date.now()
    }
    this.activeState = state

    return new Promise<string>((resolve, reject) => {
      try {
        const torrent = client.add(finalTorrentId, {
          path: destinationDir,
          announce: DEFAULT_TRACKERS
        })

        this.activeTorrent = torrent
        this.setupTorrentEvents(torrent, destinationDir)

        torrent.on('error', (err) => {
          const errorMsg = typeof err === 'string' ? err : err.message || 'Torrent error'
          console.error('[TorrentEngine] Torrent error:', errorMsg)
          state.status = 'error'
          state.error = errorMsg
          this.callbacks?.onError(state, new Error(errorMsg))
        })

        // Resolve immediately so UI transitions to DownloadingScreen without stalling
        resolve(state.id)
        this.pushUpdate()
      } catch (err) {
        console.error('[TorrentEngine] Failed to add torrent:', err)
        reject(err)
      }
    })
  }

  private syncTelemetryAndBlocks(torrent: Torrent): void {
    if (!this.activeState) return

    this.activeState.bytesDownloaded = torrent.downloaded
    this.activeState.speedBytesPerSec = torrent.downloadSpeed
    this.activeState.torrentPeers = torrent.numPeers
    this.activeState.torrentUploadSpeed = torrent.uploadSpeed

    if (this.activeState.chunks.length > 0) {
      const numChunks = this.activeState.chunks.length
      const totalSpeed = torrent.downloadSpeed
      const totalDownloaded = torrent.downloaded
      const baseSpeed = Math.floor(totalSpeed / numChunks)
      const remSpeed = totalSpeed % numChunks
      const baseDownloaded = Math.floor(totalDownloaded / numChunks)
      const remDownloaded = totalDownloaded % numChunks

      for (let i = 0; i < numChunks; i++) {
        this.activeState.chunks[i].speedBytesPerSec = baseSpeed + (i < remSpeed ? 1 : 0)
        this.activeState.chunks[i].bytesDownloaded = baseDownloaded + (i < remDownloaded ? 1 : 0)
      }
    }

    const numPieces = torrent.pieces ? torrent.pieces.length : 0
    if (numPieces > 0) {
      const pieceLength = torrent.pieceLength || Math.ceil((torrent.length || 1) / numPieces)
      const totalLength = torrent.length || this.activeState.totalBytes
      const maxDisplayBlocks = 120
      const stride = numPieces > maxDisplayBlocks ? Math.ceil(numPieces / maxDisplayBlocks) : 1
      const numBlocks = Math.ceil(numPieces / stride)

      const bitfield = (torrent as unknown as { bitfield?: { get: (i: number) => boolean } })
        .bitfield

      // Initialize blocks once if not yet sized
      let blocks: BlockState[] | undefined = this.activeState.blocks
      if (!blocks || blocks.length !== numBlocks) {
        blocks = new Array(numBlocks)
        for (let b = 0; b < numBlocks; b++) {
          const startPiece = b * stride
          const endPiece = Math.min((b + 1) * stride, numPieces)
          const rangeStart = startPiece * pieceLength
          const rangeEnd = Math.min(endPiece * pieceLength, totalLength) - 1
          const assignedChunk =
            this.activeState.chunks.length > 0
              ? this.activeState.chunks[b % this.activeState.chunks.length]
              : null
          const interfaceId = assignedChunk?.interfaceId || 'torrent-swarm'
          blocks[b] = {
            index: b,
            rangeStart,
            rangeEnd,
            status: 'pending',
            interfaceId,
            bytesDownloaded: 0,
            bytesByInterface: { [interfaceId]: 0 }
          }
        }
        this.activeState.blocks = blocks
        this.activeState.totalBlocks = numBlocks
        this.activeState.blockSizeBytes = pieceLength * stride
      }

      // Mutate existing block objects in-place with zero allocations
      for (let b = 0; b < numBlocks; b++) {
        const block = blocks[b]
        if (block.status === 'completed') continue

        const startPiece = b * stride
        const endPiece = Math.min((b + 1) * stride, numPieces)
        let completedCount = 0
        for (let p = startPiece; p < endPiece; p++) {
          const isPieceDone = bitfield ? Boolean(bitfield.get(p)) : torrent.pieces[p] === null
          if (isPieceDone) {
            completedCount++
          }
        }

        const totalPieceCount = endPiece - startPiece
        const isComplete = completedCount === totalPieceCount
        const blockBytes = Math.max(
          0,
          block.rangeEnd !== null ? block.rangeEnd - block.rangeStart + 1 : 0
        )
        const bytesDownloaded = Math.round((completedCount / totalPieceCount) * blockBytes)
        const newStatus = isComplete ? 'completed' : bytesDownloaded > 0 ? 'downloading' : 'pending'

        if (block.status !== newStatus || block.bytesDownloaded !== bytesDownloaded) {
          block.status = newStatus
          block.bytesDownloaded = bytesDownloaded
          const ifaceId = block.interfaceId || 'torrent-swarm'
          if (!block.bytesByInterface) {
            block.bytesByInterface = { [ifaceId]: bytesDownloaded }
          } else {
            block.bytesByInterface[ifaceId] = bytesDownloaded
          }
        }
      }
    }
  }

  private setupTorrentEvents(torrent: Torrent, destinationDir: string): void {
    const syncMetadata = (): void => {
      if (!this.activeState) return
      console.log(
        `[TorrentEngine] Metadata resolved! Name: "${torrent.name}", Size: ${torrent.length} bytes, Pieces: ${torrent.pieces?.length || 0}`
      )
      this.activeState.fileName = torrent.name || this.activeState.fileName
      this.activeState.totalBytes = torrent.length || this.activeState.totalBytes
      this.activeState.destinationPath = join(
        destinationDir,
        torrent.name || this.activeState.fileName
      )
      this.syncTelemetryAndBlocks(torrent)
      this.pushUpdate()
    }

    if (torrent.metadata) {
      syncMetadata()
    } else {
      torrent.on('metadata', () => {
        syncMetadata()
      })
      torrent.on('ready', () => {
        syncMetadata()
      })
    }

    // Wire connection event: log peer discovery and schedule update
    torrent.on('wire', (wire) => {
      console.log(
        `[TorrentEngine] Peer connected! Total connected peers: ${torrent.numPeers} (remote: ${(wire as unknown as { remoteAddress?: string })?.remoteAddress || 'wire'})`
      )
      if (!this.activeState) return
      this.activeState.torrentPeers = torrent.numPeers
      this.throttledUpdate(torrent)
    })

    // Continuous 1-second ticker to sync peer counts, speeds, and block progress
    if (this.peerSyncInterval) {
      clearInterval(this.peerSyncInterval)
    }
    this.peerSyncInterval = setInterval(() => {
      if (!this.activeState || this.activeState.status !== 'downloading') return
      this.throttledUpdate(torrent)
    }, 1000)

    // Data packet arrival: update scalars and schedule throttled render
    torrent.on('download', () => {
      if (!this.activeState || this.activeState.status !== 'downloading') return
      this.activeState.bytesDownloaded = torrent.downloaded
      this.activeState.speedBytesPerSec = torrent.downloadSpeed
      this.activeState.torrentPeers = torrent.numPeers
      this.activeState.torrentUploadSpeed = torrent.uploadSpeed
      this.throttledUpdate(torrent)
    })

    torrent.on('done', () => {
      if (this.peerSyncInterval) {
        clearInterval(this.peerSyncInterval)
        this.peerSyncInterval = null
      }
      if (!this.activeState) return
      this.activeState.status = 'completed'
      this.activeState.completedAt = Date.now()
      this.activeState.bytesDownloaded = torrent.length || this.activeState.totalBytes
      this.activeState.speedBytesPerSec = 0
      this.activeState.torrentPeers = torrent.numPeers

      if (this.activeState.blocks) {
        for (const block of this.activeState.blocks) {
          block.status = 'completed'
          const blockBytes = block.rangeEnd !== null ? block.rangeEnd - block.rangeStart + 1 : 0
          block.bytesDownloaded = blockBytes
          const interfaceId = block.interfaceId || 'torrent-swarm'
          block.bytesByInterface = { [interfaceId]: blockBytes }
        }
      }

      if (this.activeState.chunks.length > 0) {
        const numChunks = this.activeState.chunks.length
        const total = this.activeState.totalBytes
        const baseBytes = Math.floor(total / numChunks)
        const remBytes = total % numChunks
        for (let i = 0; i < numChunks; i++) {
          this.activeState.chunks[i].status = 'completed'
          this.activeState.chunks[i].speedBytesPerSec = 0
          this.activeState.chunks[i].bytesDownloaded = baseBytes + (i < remBytes ? 1 : 0)
        }
      }

      if (Notification.isSupported()) {
        new Notification({
          title: 'Download complete',
          body: this.activeState.fileName
        }).show()
      }

      this.pushUpdate()
      this.callbacks?.onDone(this.activeState)
    })
  }

  private throttledUpdate(torrent?: Torrent): void {
    if (this.updateTimer) return
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      const targetTorrent = torrent || this.activeTorrent
      if (targetTorrent) {
        this.syncTelemetryAndBlocks(targetTorrent)
      }
      this.pushUpdate()
    }, 200)
  }

  private pushUpdate(): void {
    if (this.activeState && this.callbacks) {
      this.callbacks.onUpdate(structuredClone(this.activeState))
    }
  }

  pause(): void {
    if (!this.activeTorrent || !this.activeState) return
    this.activeTorrent.pause()
    this.activeState.status = 'paused'
    this.activeState.speedBytesPerSec = 0
    this.activeState.pausedAt = Date.now()
    if (this.activeState.chunks.length > 0) {
      this.activeState.chunks[0].status = 'paused'
      this.activeState.chunks[0].speedBytesPerSec = 0
    }
    this.pushUpdate()
  }

  resume(): void {
    if (!this.activeTorrent || !this.activeState) return
    this.activeTorrent.resume()
    this.activeState.status = 'downloading'
    if (this.activeState.pausedAt) {
      this.activeState.totalPausedMs =
        (this.activeState.totalPausedMs ?? 0) + (Date.now() - this.activeState.pausedAt)
      this.activeState.pausedAt = undefined
    }
    if (this.activeState.chunks.length > 0) {
      this.activeState.chunks[0].status = 'downloading'
    }
    this.pushUpdate()
  }

  cancel(): void {
    if (this.peerSyncInterval) {
      clearInterval(this.peerSyncInterval)
      this.peerSyncInterval = null
    }
    if (this.updateTimer) {
      clearTimeout(this.updateTimer)
      this.updateTimer = null
    }
    if (this.activeTorrent) {
      try {
        this.activeTorrent.destroy({ destroyStore: false })
      } catch (err) {
        console.error('[TorrentEngine] Error destroying torrent on cancel:', err)
      }
      this.activeTorrent = null
    }
    if (this.activeState) {
      this.activeState.status = 'cancelled'
      this.activeState.speedBytesPerSec = 0
      this.pushUpdate()
    }
    this.activeState = null
    this.callbacks = null
  }

  remove(): void {
    if (this.peerSyncInterval) {
      clearInterval(this.peerSyncInterval)
      this.peerSyncInterval = null
    }
    if (this.updateTimer) {
      clearTimeout(this.updateTimer)
      this.updateTimer = null
    }
    if (this.activeTorrent) {
      try {
        this.activeTorrent.destroy({ destroyStore: false })
      } catch (err) {
        console.error('[TorrentEngine] Error destroying torrent on remove:', err)
      }
      this.activeTorrent = null
    }
    this.activeState = null
    this.callbacks = null
  }
}

export const torrentEngine = new TorrentEngine()
