import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { ColorBadge } from '../components/ColorBadge'
import { formatBytes, formatSpeed } from '../utils/format'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Flame,
  HelpCircle,
  Layers,
  Power,
  Server,
  Settings2,
  ShieldCheck,
  Wifi
} from 'lucide-react'
import { cn } from 'cn'
import type { ProxyAlgorithm } from '@shared/types'

export function ProxyScreen(): React.JSX.Element {
  const interfaces = useAppStore((state) => state.interfaces)
  const proxyStatus = useAppStore((state) => state.proxyStatus)
  const proxyConfig = useAppStore((state) => state.proxyConfig)
  const setProxyConfig = useAppStore((state) => state.setProxyConfig)
  const startProxy = useAppStore((state) => state.startProxy)
  const stopProxy = useAppStore((state) => state.stopProxy)
  const toggleSystemProxy = useAppStore((state) => state.toggleSystemProxy)

  const [copiedPort, setCopiedPort] = useState<string | null>(null)
  const [showSteamGuide, setShowSteamGuide] = useState(false)
  const [isStarting, setIsStarting] = useState(false)

  const isRunning = Boolean(proxyStatus?.running)
  const systemProxyEnabled = Boolean(proxyStatus?.systemProxyEnabled)

  const handleCopy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text)
    setCopiedPort(label)
    setTimeout(() => setCopiedPort(null), 2000)
  }

  const handleToggleRunning = async (): Promise<void> => {
    setIsStarting(true)
    try {
      if (isRunning) {
        await stopProxy()
      } else {
        await startProxy()
      }
    } finally {
      setIsStarting(false)
    }
  }

  const handleToggleInterface = (ifaceId: string): void => {
    const current =
      proxyConfig.selectedInterfaceIds.length > 0
        ? proxyConfig.selectedInterfaceIds
        : interfaces.map((i) => i.id)

    let next: string[]
    if (current.includes(ifaceId)) {
      if (current.length === 1) return // Keep at least one interface
      next = current.filter((id) => id !== ifaceId)
    } else {
      next = [...current, ifaceId]
    }

    setProxyConfig({ selectedInterfaceIds: next })
    if (isRunning) {
      void startProxy()
    }
  }

  const handleAlgorithmChange = (algo: ProxyAlgorithm): void => {
    setProxyConfig({ algorithm: algo })
    if (isRunning) {
      void startProxy()
    }
  }

  const handleToggleAffinity = (): void => {
    setProxyConfig({ sessionAffinity: !proxyConfig.sessionAffinity })
    if (isRunning) {
      void startProxy()
    }
  }

  const selectedIds = new Set(
    proxyConfig.selectedInterfaceIds.length > 0
      ? proxyConfig.selectedInterfaceIds
      : interfaces.map((i) => i.id)
  )

  const totalDownSpeed = proxyStatus?.speedBytesPerSecDown ?? 0
  const totalUpSpeed = proxyStatus?.speedBytesPerSecUp ?? 0
  const totalDownBytes = proxyStatus?.totalBytesDown ?? 0
  const totalUpBytes = proxyStatus?.totalBytesUp ?? 0
  const activeConns = proxyStatus?.activeConnections ?? 0

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background p-5 text-foreground select-none">
      {/* Header Banner */}
      <div className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card/60 p-5 shadow-sm backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div
              className={cn(
                'relative flex size-11 items-center justify-center rounded-xl border transition-all',
                isRunning
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.2)]'
                  : 'border-border bg-muted/30 text-muted-foreground'
              )}
            >
              <Server className="size-5.5" />
              {isRunning && (
                <span className="absolute -top-1 -right-1 flex size-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex size-3 rounded-full bg-emerald-500" />
                </span>
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight">Channel-Bonding Proxy Server</h1>
                <ColorBadge
                  bg={isRunning ? 'rgba(16, 185, 129, 0.12)' : 'rgba(120, 120, 128, 0.12)'}
                  border={isRunning ? 'rgba(16, 185, 129, 0.3)' : 'rgba(120, 120, 128, 0.25)'}
                  text={isRunning ? 'rgb(52, 211, 153)' : 'var(--muted-foreground)'}
                  className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider"
                >
                  {isRunning ? 'Running' : 'Stopped'}
                </ColorBadge>
              </div>
              <p className="text-xs text-muted-foreground">
                Routes external apps (Steam, browsers, launchers) across bonded networks in
                parallel.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              type="button"
              variant={isRunning ? 'destructive' : 'default'}
              size="sm"
              disabled={isStarting}
              onClick={handleToggleRunning}
              className="gap-2 font-mono text-xs font-semibold shadow-xs"
            >
              <Power className="size-3.5" />
              {isRunning ? 'Stop Proxy' : 'Start Proxy'}
            </Button>

            <Button
              type="button"
              variant={systemProxyEnabled ? 'secondary' : 'outline'}
              size="sm"
              disabled={!isRunning}
              onClick={() => void toggleSystemProxy(!systemProxyEnabled)}
              className={cn(
                'gap-2 font-mono text-xs transition-colors',
                systemProxyEnabled && 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
              )}
              title="Automatically configure Windows internet settings to route via Plexo"
            >
              <ShieldCheck className="size-3.5" />
              {systemProxyEnabled ? 'System Proxy: ON' : 'Set as Windows Proxy'}
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowSteamGuide(!showSteamGuide)}
              className="gap-1.5 font-mono text-xs"
            >
              <HelpCircle className="size-3.5" />
              Steam Guide
            </Button>
          </div>
        </div>

        {/* Quick Connection Endpoints */}
        <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-border/40 text-xs">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--input-bg)] px-3 py-1.5 border border-border/50">
            <span className="font-mono text-muted-foreground uppercase text-[10px] font-bold">
              HTTP/HTTPS CONNECT:
            </span>
            <code className="font-mono text-foreground font-semibold">
              127.0.0.1:{proxyConfig.httpPort}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(`127.0.0.1:${proxyConfig.httpPort}`, 'http')}
              className="text-muted-foreground hover:text-foreground transition-colors ml-1 cursor-pointer"
              title="Copy HTTP Proxy"
            >
              {copiedPort === 'http' ? (
                <Check className="size-3 text-emerald-400" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-[var(--input-bg)] px-3 py-1.5 border border-border/50">
            <span className="font-mono text-muted-foreground uppercase text-[10px] font-bold">
              SOCKS5:
            </span>
            <code className="font-mono text-foreground font-semibold">
              127.0.0.1:{proxyConfig.socksPort}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(`127.0.0.1:${proxyConfig.socksPort}`, 'socks')}
              className="text-muted-foreground hover:text-foreground transition-colors ml-1 cursor-pointer"
              title="Copy SOCKS5 Proxy"
            >
              {copiedPort === 'socks' ? (
                <Check className="size-3 text-emerald-400" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </div>

          <div className="ml-auto flex items-center gap-4 text-xs font-mono text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Activity className="size-3.5 text-primary" />
              <strong className="text-foreground">{activeConns}</strong> active sockets
            </span>
            <span className="flex items-center gap-1.5">
              <ArrowDown className="size-3.5 text-emerald-400" />
              <strong className="text-foreground">{formatSpeed(totalDownSpeed)}</strong>
            </span>
            <span className="flex items-center gap-1.5">
              <ArrowUp className="size-3.5 text-cyan-400" />
              <strong className="text-foreground">{formatSpeed(totalUpSpeed)}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Steam Configuration Popover Guide */}
      {showSteamGuide && (
        <div className="mt-3.5 rounded-xl border border-primary/40 bg-card p-4 text-xs shadow-md animate-in fade-in slide-in-from-top-2">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2 font-bold text-foreground">
              <Flame className="size-4 text-amber-500" />
              How to Accelerate Steam Game Downloads with Plexo
            </div>
            <button
              type="button"
              onClick={() => setShowSteamGuide(false)}
              className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
            >
              ✕ Close
            </button>
          </div>
          <div className="mt-2.5 grid grid-cols-1 md:grid-cols-3 gap-3 text-muted-foreground">
            <div className="rounded-lg bg-[var(--input-bg)] p-3 border border-border/40">
              <div className="font-semibold text-foreground mb-1">
                Method 1: One-Click (Recommended)
              </div>
              <p>
                Click <strong className="text-foreground">&quot;Set as Windows Proxy&quot;</strong>{' '}
                above. Windows immediately routes Steam, Epic Games, and web browsers through Plexo.
              </p>
            </div>
            <div className="rounded-lg bg-[var(--input-bg)] p-3 border border-border/40">
              <div className="font-semibold text-foreground mb-1">Method 2: Steam Launch Flag</div>
              <p>
                Right-click your Steam Desktop shortcut → Properties → in Target, append:
                <br />
                <code className="text-primary font-mono text-[11px] block mt-1">
                  -httpproxy 127.0.0.1:{proxyConfig.httpPort}
                </code>
              </p>
            </div>
            <div className="rounded-lg bg-[var(--input-bg)] p-3 border border-border/40">
              <div className="font-semibold text-foreground mb-1">Method 3: SOCKS5 in Apps</div>
              <p>
                In apps like Firefox, Discord, or torrent tools, configure SOCKS5 proxy host to{' '}
                <code className="text-foreground font-mono">127.0.0.1</code> and port{' '}
                <code className="text-foreground font-mono">{proxyConfig.socksPort}</code>.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Main Grid: Bonded Networks + Settings & Live Streams */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left 2 Cols: Bonded Network Interfaces */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Wifi className="size-3.5" />
              Bonded Network Interfaces ({selectedIds.size} of {interfaces.length} active)
            </h2>
            <span className="text-[11px] text-muted-foreground">
              Select networks to distribute outgoing streams
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {interfaces.map((iface) => {
              const isSelected = selectedIds.has(iface.id)
              const ifaceStat = proxyStatus?.interfaces.find((s) => s.interfaceId === iface.id)

              return (
                <div
                  key={iface.id}
                  onClick={() => handleToggleInterface(iface.id)}
                  className={cn(
                    'flex flex-col justify-between rounded-xl border p-4 transition-all cursor-pointer',
                    isSelected
                      ? 'border-primary/40 bg-card hover:border-primary/60 shadow-xs'
                      : 'border-border/40 bg-muted/10 opacity-60 hover:opacity-100'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => handleToggleInterface(iface.id)}
                      />
                      <div>
                        <div className="font-semibold text-sm text-foreground">
                          {iface.displayName}
                        </div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {iface.address} · {iface.kind.toUpperCase()}
                        </div>
                      </div>
                    </div>
                    <ColorBadge
                      bg={isSelected ? 'var(--color-wifi-bg)' : 'transparent'}
                      border={isSelected ? 'var(--color-wifi-border)' : 'var(--border)'}
                      text={isSelected ? 'var(--color-wifi-text)' : 'var(--muted-foreground)'}
                      className="rounded-full px-2 py-0.5 text-[9px] font-mono font-semibold uppercase"
                    >
                      {isSelected ? 'Bonded' : 'Disabled'}
                    </ColorBadge>
                  </div>

                  <div className="mt-4 pt-3 border-t border-border/40 grid grid-cols-3 gap-2 text-xs font-mono">
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase">Speed ↓</div>
                      <div className="font-bold text-emerald-400">
                        {formatSpeed(ifaceStat?.speedBytesPerSecDown ?? 0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase">Speed ↑</div>
                      <div className="font-bold text-cyan-400">
                        {formatSpeed(ifaceStat?.speedBytesPerSecUp ?? 0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase">Sockets</div>
                      <div className="font-bold text-foreground">
                        {ifaceStat?.activeConnections ?? 0}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Real-time Streams Log */}
          <div className="mt-2 flex flex-col gap-2 rounded-xl border border-border/80 bg-card/60 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Layers className="size-3.5 text-primary" />
                Live Connection Streams
              </h3>
              <span className="text-[11px] text-muted-foreground font-mono">
                {proxyStatus?.recentConnections.length ?? 0} recent requests
              </span>
            </div>

            <div className="max-h-48 overflow-y-auto rounded-lg border border-border/40 bg-[var(--input-bg)]">
              {proxyStatus?.recentConnections && proxyStatus.recentConnections.length > 0 ? (
                <div className="divide-y divide-border/30 text-[11px] font-mono">
                  {proxyStatus.recentConnections.map((conn) => (
                    <div
                      key={conn.id}
                      className="flex items-center justify-between px-3 py-1.5 hover:bg-card/40 transition-colors"
                    >
                      <div className="flex items-center gap-2 truncate pr-2">
                        <span className="rounded bg-muted/60 px-1 py-0.5 text-[9px] text-muted-foreground font-bold">
                          {conn.protocol}
                        </span>
                        <span className="text-foreground truncate" title={conn.targetHost}>
                          {conn.targetHost}:{conn.targetPort}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-primary font-semibold">{conn.interfaceLabel}</span>
                        <span className="text-muted-foreground">
                          {formatBytes(conn.bytesDown + conn.bytesUp)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  No active proxy connections yet. Start downloading in Steam or open a browser to
                  see traffic flow!
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Col: Balancer Config & Summary */}
        <div className="flex flex-col gap-3">
          <div className="text-xs font-mono font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Settings2 className="size-3.5" />
            Balancer Settings
          </div>

          <div className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card/60 p-4">
            {/* Balancing Algorithm */}
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1.5">
                Load Balancing Mode
              </label>
              <div className="flex flex-col gap-1.5">
                {[
                  {
                    id: 'round-robin' as ProxyAlgorithm,
                    label: 'Round-Robin',
                    desc: 'Alternates streams 50/50. Best for Steam.'
                  },
                  {
                    id: 'least-connections' as ProxyAlgorithm,
                    label: 'Least Connections',
                    desc: 'Sends stream to interface with fewest sockets.'
                  },
                  {
                    id: 'ip-hash' as ProxyAlgorithm,
                    label: 'IP / Domain Hash',
                    desc: 'Hashes host to consistent interface.'
                  }
                ].map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => handleAlgorithmChange(mode.id)}
                    className={cn(
                      'flex flex-col text-left p-2.5 rounded-lg border transition-all cursor-pointer',
                      proxyConfig.algorithm === mode.id
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-border/40 hover:bg-muted/30 text-muted-foreground'
                    )}
                  >
                    <span className="font-semibold text-xs text-foreground">{mode.label}</span>
                    <span className="text-[10px] text-muted-foreground">{mode.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Session Affinity */}
            <div className="pt-3 border-t border-border/40">
              <label
                onClick={handleToggleAffinity}
                className="flex items-start gap-2.5 cursor-pointer text-xs"
              >
                <Checkbox
                  checked={proxyConfig.sessionAffinity}
                  onCheckedChange={handleToggleAffinity}
                  className="mt-0.5"
                />
                <div>
                  <span className="font-semibold text-foreground block">Session Affinity</span>
                  <span className="text-[11px] text-muted-foreground block leading-tight">
                    Keep connections to the same host on one network to prevent game lobbies from
                    disconnecting.
                  </span>
                </div>
              </label>
            </div>

            {/* Total Traffic Summary */}
            <div className="pt-3 border-t border-border/40 text-xs font-mono flex flex-col gap-2">
              <div className="text-[10px] text-muted-foreground uppercase font-bold">
                Session Telemetry
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Downloaded:</span>
                <span className="font-bold text-foreground">{formatBytes(totalDownBytes)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Uploaded:</span>
                <span className="font-bold text-foreground">{formatBytes(totalUpBytes)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Active Sockets:</span>
                <span className="font-bold text-primary">{activeConns}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
