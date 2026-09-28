import { ColorBadge } from './ColorBadge'
import { ThemeToggle } from './ThemeToggle'
import { UpdateIndicator } from './UpdateIndicator'
import { useAppStore } from '../store/useAppStore'
import { ArrowDownToLine, Radio } from 'lucide-react'
import { cn } from 'cn'

export type TitleBarStatus =
  | { kind: 'none' }
  | { kind: 'combined'; networkCount: number }
  | { kind: 'assembling' }
  | { kind: 'paused'; networkCount: number }
  | { kind: 'offline' }

const isMac = window.plexo.platform === 'darwin'

const pillClass =
  'h-auto flex items-center gap-[7px] rounded-full px-2.5 py-1 font-mono text-[10px] leading-none font-semibold tracking-[0.08em] uppercase whitespace-nowrap'
const pillDotClass = 'size-1.5 shrink-0 rounded-full'

export function TitleBar({ status }: { status: TitleBarStatus }): React.JSX.Element {
  const dimmed = status.kind === 'offline'
  const activeTab = useAppStore((state) => state.activeTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const proxyStatus = useAppStore((state) => state.proxyStatus)

  return (
    <div
      className={`flex h-11 shrink-0 items-center gap-[13px] border-b-[0.5px] border-border bg-card pr-3.5 [-webkit-app-region:drag] ${
        // Real traffic lights are inset here on macOS (see main/index.ts, trafficLightPosition) —
        // 16px inset + ~52px cluster width + a clear ~26px gap before our own content starts.
        isMac ? 'pl-[94px]' : 'pl-3.5'
      }`}
    >
      <div
        // Matches the "LOCKUP · horizontal" wordmark spec from the final icon design.
        className={`font-sans text-[13px] leading-none font-bold tracking-[-0.02em] ${
          dimmed ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        Plexo
      </div>

      {/* Mode switcher tabs */}
      <div className="flex items-center rounded-md bg-[var(--input-bg)] p-0.5 border border-border/60 [-webkit-app-region:no-drag]">
        <button
          type="button"
          onClick={() => setActiveTab('downloader')}
          className={cn(
            'flex items-center gap-1.5 rounded-[4px] px-2.5 py-1 font-mono text-[11px] font-medium transition-all cursor-pointer',
            activeTab === 'downloader'
              ? 'bg-background text-foreground shadow-xs font-semibold'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <ArrowDownToLine className="size-3 text-muted-foreground" />
          <span>Downloader</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('proxy')}
          className={cn(
            'flex items-center gap-1.5 rounded-[4px] px-2.5 py-1 font-mono text-[11px] font-medium transition-all cursor-pointer',
            activeTab === 'proxy'
              ? 'bg-background text-foreground shadow-xs font-semibold'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Radio className="size-3 text-muted-foreground" />
          <span>Proxy Server</span>
          {proxyStatus?.running && (
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          )}
        </button>
      </div>

      <div className="flex-1" />
      {status.kind === 'combined' && (
        <ColorBadge
          bg="var(--color-wifi-bg)"
          border="var(--color-wifi-border)"
          text="var(--color-wifi-text)"
          className={pillClass}
        >
          <div
            className={`${pillDotClass} bg-[var(--color-wifi)] animate-[plexo-glow_2s_ease-in-out_infinite]`}
          />
          {status.networkCount} {status.networkCount === 1 ? 'network' : 'networks'} combined
        </ColorBadge>
      )}
      {status.kind === 'assembling' && (
        <ColorBadge
          bg="var(--color-ethernet-bg)"
          border="var(--color-ethernet-border)"
          text="var(--color-ethernet-text)"
          className={pillClass}
        >
          <div
            className={`${pillDotClass} bg-[var(--color-ethernet)] animate-[plexo-glow_1s_ease-in-out_infinite]`}
          />
          Assembling file…
        </ColorBadge>
      )}
      {status.kind === 'paused' && (
        <ColorBadge
          bg="var(--color-usb-bg)"
          border="var(--color-usb-border)"
          text="var(--color-usb-text)"
          className={pillClass}
        >
          <div className={`${pillDotClass} bg-[var(--color-usb)]`} />
          {status.networkCount} {status.networkCount === 1 ? 'network' : 'networks'} · Paused
        </ColorBadge>
      )}
      {status.kind === 'offline' && (
        <ColorBadge
          bg="var(--color-danger-bg)"
          border="var(--color-danger-border)"
          text="var(--color-danger)"
          className={pillClass}
        >
          <div className={`${pillDotClass} bg-[var(--color-danger)]`} />
          Offline
        </ColorBadge>
      )}
      <UpdateIndicator />
      <ThemeToggle />
    </div>
  )
}
