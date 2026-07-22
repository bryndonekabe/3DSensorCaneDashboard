import { useState, useEffect, useRef, useCallback, useMemo, DragEvent } from 'react'
import mqtt from 'mqtt'
import Viewer3D from './Viewer3D'
import type { CaneFrame, CaneSettings, ConnectionStatus, Diagnostics, MotorState, Protocol } from './types'
import { MAX_RANGE, SENSOR_COLS, GRID_SIZE } from './types'

// ─── Demo data ────────────────────────────────────────────────────────────────
function generateDemoFrame(t: number): CaneFrame {
  const updates: { i: number; d: number }[] = []
  for (let i = 0; i < GRID_SIZE; i++) {
    if (Math.random() > 0.55) continue
    const row = Math.floor(i / SENSOR_COLS), col = i % SENSOR_COLS
    const base = 2.2 + Math.sin(t * 0.5 + col * 0.4) * 0.7
    const obstacle = col >= 3 && col <= 4 && row >= 3 && row <= 5
      ? 0.7 + Math.abs(Math.sin(t * 1.2)) * 0.3 : base
    updates.push({ i, d: Math.max(0.1, obstacle + (Math.random() - 0.5) * 0.05) })
  }
  const leftClose = updates.some(u => u.i % SENSOR_COLS < 4 && u.d < 1.2)
  const rightClose = updates.some(u => u.i % SENSOR_COLS >= 4 && u.d < 1.2)
  return {
    timestamp: Date.now(), updates,
    motors: {
      left: leftClose ? Math.max(0, 0.55 + Math.sin(t * 8) * 0.3) : 0,
      right: rightClose ? Math.max(0, 0.55 + Math.sin(t * 8 + 1) * 0.3) : 0,
    },
    diagnostics: {
      cpu: 36 + Math.sin(t * 0.7) * 14,
      battery: Math.max(0, 82 - t * 0.008),
      refresh_rate: 28 + Math.random() * 4,
      speed: Math.abs(Math.sin(t * 0.4)) * 1.1,
      bottleneck: t % 18 < 1.5 ? 'sensor' : 'none',
      uptime: Math.floor(t),
      temp: 41 + Math.sin(t * 0.5) * 5,
      signal: -60 + Math.sin(t * 0.9) * 8,
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatUptime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}
function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n/1024).toFixed(1)} KB`
  return `${(n/1048576).toFixed(2)} MB`
}

// ─── Atom components ──────────────────────────────────────────────────────────
function StatusDot({ status }: { status: ConnectionStatus }) {
  const cls = status==='connected'?'bg-[#00cc66]':status==='connecting'?'bg-[#ffaa00]':status==='error'?'bg-[#ff4444]':'bg-[#2a4060]'
  return (
    <span className="relative inline-flex w-2.5 h-2.5 items-center justify-center shrink-0">
      {(status==='connected'||status==='connecting') && <span className={`absolute w-full h-full rounded-full ${cls} opacity-40 animate-ping`}/>}
      <span className={`relative w-2 h-2 rounded-full ${cls}`}/>
    </span>
  )
}

function GaugeBar({ value, max=100, color, label, unit='%' }: { value:number; max?:number; color:string; label:string; unit?:string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] text-slate-500 uppercase tracking-widest">{label}</span>
        <span className="font-mono text-[11px]" style={{color}}>{value.toFixed(1)}{unit}</span>
      </div>
      <div className="h-0.5 rounded-full bg-[#0d1f30] overflow-hidden">
        <div className="h-full rounded-full transition-all duration-200" style={{width:`${Math.min(value/max*100,100)}%`,background:color}}/>
      </div>
    </div>
  )
}

function Tile({ label, value, unit, warn=false }: { label:string; value:string|number; unit?:string; warn?:boolean }) {
  return (
    <div className={`flex flex-col gap-0.5 rounded p-2 border ${warn?'border-[#ff444433] bg-[#ff44440a]':'border-[#1a2d42] bg-[#0d1520]'}`}>
      <span className="text-[9px] uppercase tracking-widest text-slate-500">{label}</span>
      <span className="font-mono text-xs leading-tight" style={{color:warn?'#ff4444':'#c8ddf0'}}>
        {value}{unit&&<span className="text-[10px] text-slate-500 ml-0.5">{unit}</span>}
      </span>
    </div>
  )
}

function Slider({ label, value, min, max, step=0.01, unit, onChange }: {
  label:string; value:number; min:number; max:number; step?:number; unit?:string; onChange:(v:number)=>void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] uppercase tracking-widest text-slate-500">{label}</span>
        <span className="font-mono text-[11px] text-[#00e5ff]">{value.toFixed(step<0.1?2:0)}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e=>onChange(Number(e.target.value))}
        className="w-full h-0.5 appearance-none bg-[#0d1f30] rounded accent-[#00e5ff] cursor-pointer"/>
    </div>
  )
}

function BatteryIcon({ pct }: { pct: number }) {
  const color = pct>50?'#00cc66':pct>20?'#ffaa00':'#ff4444'
  return (
    <svg width="26" height="13" viewBox="0 0 26 13" fill="none" className="shrink-0">
      <rect x=".5" y=".5" width="22" height="12" rx="2" stroke={color} strokeOpacity=".5"/>
      <rect x="1" y="1" width={Math.round(20*pct/100)} height="11" rx="1.5" fill={color} fillOpacity=".8"/>
      <rect x="23" y="3.5" width="2.5" height="5" rx="1" fill={color} fillOpacity=".4"/>
    </svg>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[9px] uppercase tracking-widest text-slate-500">{children}</span>
}

function Divider() {
  return <div className="h-px bg-[#1a2d42]" />
}

// ─── Types ────────────────────────────────────────────────────────────────────
const EMPTY_DIAG: Diagnostics = { cpu:0, battery:100, refresh_rate:0, speed:0, bottleneck:'none', uptime:0 }
const EMPTY_MOTORS: MotorState = { left:0, right:0 }
const DEFAULT_SETTINGS: CaneSettings = { motor_left_mult:1.0, motor_right_mult:1.0, refresh_rate:30, threshold_near:0.8, threshold_far:2.5 }
const TABS = ['diag','config','settings','firmware'] as const
type Tab = typeof TABS[number]
const TAB_LABELS: Record<Tab, string> = { diag:'Diag', config:'Config', settings:'Tune', firmware:'FW' }

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // Connection
  const [protocol, setProtocol] = useState<Protocol>('websocket')
  const [wsHost, setWsHost] = useState('192.168.1.100')
  const [wsPort, setWsPort] = useState('8765')
  const [mqttHost, setMqttHost] = useState('192.168.1.100')
  const [mqttPort, setMqttPort] = useState('9001')
  const [mqttDataTopic, setMqttDataTopic] = useState('cane/data')
  const [mqttCmdTopic, setMqttCmdTopic] = useState('cane/cmd')
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [demoMode, setDemoMode] = useState(false)

  // Live data
  const depthBufferRef = useRef<Float32Array>(new Float32Array(GRID_SIZE).fill(NaN))
  const [depthVersion, setDepthVersion] = useState(0)
  const depthSnapshot = useMemo(() => new Float32Array(depthBufferRef.current), [depthVersion]) // eslint-disable-line
  const [motors, setMotors] = useState<MotorState>(EMPTY_MOTORS)
  const [diag, setDiag] = useState<Diagnostics>(EMPTY_DIAG)
  const [frameCount, setFrameCount] = useState(0)
  const [lastTs, setLastTs] = useState<number|null>(null)

  // UI state
  const [tab, setTab] = useState<Tab>('config')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(272)
  const dragState = useRef<{active:boolean;startX:number;startW:number}>({active:false,startX:0,startW:272})

  // Settings
  const [pendingSettings, setPendingSettings] = useState<CaneSettings>(DEFAULT_SETTINGS)
  const [settingsSent, setSettingsSent] = useState(false)

  // Shutdown
  const [shutdownConfirm, setShutdownConfirm] = useState(false)
  const [shutdownSent, setShutdownSent] = useState(false)

  // Firmware
  const [fwFile, setFwFile] = useState<File|null>(null)
  const [fwDragging, setFwDragging] = useState(false)
  const [fwProgress, setFwProgress] = useState<number|null>(null)
  const [fwStatus, setFwStatus] = useState<'idle'|'uploading'|'done'|'error'>('idle')

  // Refs
  const wsRef = useRef<WebSocket|null>(null)
  const mqttRef = useRef<ReturnType<typeof mqtt.connect>|null>(null)
  const demoTimerRef = useRef<ReturnType<typeof setInterval>|null>(null)
  const demoTimeRef = useRef(0)

  // Sidebar drag-resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.active) return
      const w = dragState.current.startW + (e.clientX - dragState.current.startX)
      setSidebarWidth(Math.max(200, Math.min(520, w)))
    }
    const onUp = () => { dragState.current.active = false; document.body.style.cursor = '' }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    dragState.current = { active: true, startX: e.clientX, startW: sidebarWidth }
    document.body.style.cursor = 'ew-resize'
  }

  // Connection helpers
  const applyFrame = useCallback((frame: CaneFrame) => {
    for (const { i, d } of frame.updates) {
      if (i >= 0 && i < GRID_SIZE) depthBufferRef.current[i] = d
    }
    setDepthVersion(v => v + 1)
    setMotors(frame.motors)
    setDiag(frame.diagnostics)
    setLastTs(frame.timestamp)
    setFrameCount(c => c + 1)
  }, [])

  const resetData = useCallback(() => {
    depthBufferRef.current.fill(NaN)
    setDepthVersion(v => v + 1)
    setMotors(EMPTY_MOTORS)
    setDiag(EMPTY_DIAG)
    setFrameCount(0)
    setLastTs(null)
  }, [])

  const sendRaw = useCallback((payload: string | ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(payload)
    } else if (mqttRef.current?.connected) {
      if (typeof payload === 'string') mqttRef.current.publish(mqttCmdTopic, payload)
    }
  }, [mqttCmdTopic])

  const sendCommand = useCallback((obj: object) => sendRaw(JSON.stringify(obj)), [sendRaw])

  const disconnect = useCallback(() => {
    wsRef.current?.close(); wsRef.current = null
    mqttRef.current?.end(true); mqttRef.current = null
    if (demoTimerRef.current) { clearInterval(demoTimerRef.current); demoTimerRef.current = null }
    setDemoMode(false)
    setStatus('disconnected')
    resetData()
  }, [resetData])

  const connectWS = useCallback(() => {
    disconnect()
    setStatus('connecting')
    const ws = new WebSocket(`ws://${wsHost}:${wsPort}`)
    wsRef.current = ws
    ws.onopen = () => setStatus('connected')
    ws.onclose = () => { setStatus('disconnected'); wsRef.current = null }
    ws.onerror = () => setStatus('error')
    ws.onmessage = evt => { try { applyFrame(JSON.parse(evt.data)) } catch {} }
  }, [wsHost, wsPort, disconnect, applyFrame])

  const connectMQTT = useCallback(() => {
    disconnect()
    setStatus('connecting')
    const client = mqtt.connect(`ws://${mqttHost}:${mqttPort}`, { reconnectPeriod: 0 })
    mqttRef.current = client
    client.on('connect', () => {
      setStatus('connected')
      client.subscribe(mqttDataTopic)
    })
    client.on('message', (_topic, payload) => {
      try { applyFrame(JSON.parse(payload.toString())) } catch {}
    })
    client.on('error', () => setStatus('error'))
    client.on('close', () => { setStatus('disconnected'); mqttRef.current = null })
  }, [mqttHost, mqttPort, mqttDataTopic, disconnect, applyFrame])

  const connect = useCallback(() => {
    if (protocol === 'websocket') connectWS()
    else connectMQTT()
  }, [protocol, connectWS, connectMQTT])

  const startDemo = useCallback(() => {
    disconnect()
    setDemoMode(true)
    setStatus('connected')
    demoTimeRef.current = 0
    demoTimerRef.current = setInterval(() => {
      demoTimeRef.current += 1/15
      applyFrame(generateDemoFrame(demoTimeRef.current))
    }, 67)
  }, [disconnect, applyFrame])

  const sendSettings = useCallback(() => {
    sendCommand({ command:'settings', settings:pendingSettings })
    setSettingsSent(true)
    setTimeout(() => setSettingsSent(false), 1800)
  }, [sendCommand, pendingSettings])

  const sendShutdown = useCallback(() => {
    sendCommand({ command:'shutdown' })
    setShutdownSent(true)
    setTimeout(() => { disconnect(); setShutdownSent(false); setShutdownConfirm(false) }, 1500)
  }, [sendCommand, disconnect])

  // Firmware upload
  const uploadFirmware = useCallback(async () => {
    if (!fwFile) return
    setFwStatus('uploading')
    setFwProgress(0)
    try {
      const buffer = await fwFile.arrayBuffer()
      const CHUNK = 4096
      sendCommand({ command:'firmware_start', filename:fwFile.name, size:fwFile.size })
      await new Promise(r => setTimeout(r, 80))
      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK) {
        sendRaw(buffer.slice(offset, offset + CHUNK))
        setFwProgress(Math.round(Math.min(offset + CHUNK, buffer.byteLength) / buffer.byteLength * 100))
        await new Promise(r => setTimeout(r, 12))
      }
      sendCommand({ command:'firmware_end' })
      setFwStatus('done')
    } catch {
      setFwStatus('error')
    }
  }, [fwFile, sendCommand, sendRaw])

  const handleFwDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setFwDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) { setFwFile(f); setFwStatus('idle'); setFwProgress(null) }
  }, [])

  useEffect(() => () => {
    if (demoTimerRef.current) clearInterval(demoTimerRef.current)
    wsRef.current?.close()
    mqttRef.current?.end(true)
  }, [])

  const connected = status === 'connected'
  const canSend = connected && !demoMode

  return (
    <div className="flex flex-col h-screen bg-[#080c10] text-[#c8ddf0] overflow-hidden">
      {/* ── Top bar ── */}
      <header className="flex items-center gap-4 px-4 h-11 border-b border-[#1a2d42] shrink-0">
        {/* Sidebar toggle */}
        <button onClick={() => setSidebarOpen(o => !o)}
          className="flex items-center justify-center w-7 h-7 rounded border border-[#1a2d42] text-slate-500 hover:text-[#00e5ff] hover:border-[#00e5ff33] transition-colors shrink-0">
          <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
            <rect x="0" y="0" width="12" height="1.5" rx=".75" fill="currentColor"/>
            <rect x="0" y="4" width="12" height="1.5" rx=".75" fill="currentColor"/>
            <rect x="0" y="8" width="12" height="1.5" rx=".75" fill="currentColor"/>
          </svg>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <svg width="14" height="17" viewBox="0 0 14 17" fill="none">
            <path d="M7 1L7 16M7 1C7 1 2.5 5 2.5 8.5M7 1C7 1 11.5 5 11.5 8.5" stroke="#00e5ff" strokeWidth="1.2" strokeLinecap="round"/>
            <circle cx="7" cy="15.5" r="1.5" fill="#00e5ff" fillOpacity=".6"/>
          </svg>
          <span className="font-mono text-sm text-[#00e5ff] tracking-widest">CANEVIEW</span>
        </div>

        <div className="flex items-center gap-3 font-mono text-[11px] ml-2">
          <div className="flex items-center gap-1.5">
            <StatusDot status={status}/>
            <span className={status==='connected'?'text-[#00cc66]':status==='connecting'?'text-[#ffaa00]':status==='error'?'text-[#ff4444]':'text-slate-500'}>
              {demoMode ? 'DEMO' : status.toUpperCase()}
            </span>
            {connected && !demoMode && (
              <span className="text-slate-600 text-[10px] ml-0.5">
                {protocol==='mqtt'?`mqtt://${mqttHost}:${mqttPort}`:`ws://${wsHost}:${wsPort}`}
              </span>
            )}
          </div>
          {connected && <>
            <span className="text-slate-700">|</span>
            <span className="text-slate-400"><span className="text-[#00e5ff]">{diag.refresh_rate.toFixed(1)}</span> Hz</span>
            <span className="text-slate-700">|</span>
            <span className="text-slate-400"><span className="text-[#00e5ff]">{frameCount}</span> frames</span>
            {lastTs && <><span className="text-slate-700">|</span>
              <span className="text-slate-500 text-[10px]">{new Date(lastTs).toLocaleTimeString()}</span>
            </>}
          </>}
        </div>

        <div className="flex-1"/>

        {/* Quick stats */}
        {connected && (
          <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500 shrink-0">
            <BatteryIcon pct={diag.battery}/>
            <span>CPU <span className="text-[#00e5ff]">{diag.cpu.toFixed(0)}%</span></span>
            {diag.bottleneck !== 'none' && diag.bottleneck !== '' &&
              <span className="text-[#ff4444] animate-pulse">⚠ {diag.bottleneck.toUpperCase()}</span>}
          </div>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar ── */}
        {sidebarOpen && (
          <div className="flex shrink-0 overflow-hidden" style={{ width: sidebarWidth }}>
            <aside className="flex flex-col flex-1 border-r border-[#1a2d42] overflow-hidden">
              {/* Tab bar */}
              <div className="flex border-b border-[#1a2d42] shrink-0">
                {TABS.map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    className={`flex-1 py-2.5 text-[9px] uppercase tracking-widest font-mono transition-colors ${
                      tab===t ? 'text-[#00e5ff] border-b border-[#00e5ff] -mb-px' : 'text-slate-600 hover:text-slate-300'
                    }`}>
                    {TAB_LABELS[t]}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto">

                {/* ══ DIAG TAB ══ */}
                {tab === 'diag' && (
                  <div className="flex flex-col gap-4 p-4">
                    <div className="flex flex-col gap-2">
                      <SectionLabel>Power</SectionLabel>
                      <div className="flex items-center gap-3 bg-[#0d1520] border border-[#1a2d42] rounded p-3">
                        <BatteryIcon pct={diag.battery}/>
                        <div className="flex flex-col">
                          <span className="font-mono text-xl leading-none" style={{
                            color: diag.battery>50?'#00cc66':diag.battery>20?'#ffaa00':'#ff4444'
                          }}>{diag.battery.toFixed(0)}%</span>
                          <span className="text-[9px] text-slate-500">Battery</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <SectionLabel>Performance</SectionLabel>
                      <GaugeBar value={diag.cpu} label="CPU"
                        color={diag.cpu>80?'#ff4444':diag.cpu>60?'#ffaa00':'#00e5ff'}/>
                      <GaugeBar value={diag.refresh_rate} max={60} label="Refresh" unit=" Hz" color="#00cc66"/>
                      <GaugeBar value={diag.speed} max={2} label="Speed" unit=" m/s" color="#00e5ff"/>
                    </div>

                    <div className="flex flex-col gap-3">
                      <SectionLabel>Vibration Motors</SectionLabel>
                      <GaugeBar value={motors.left*100} label="Left" color="#00e5ff"/>
                      <GaugeBar value={motors.right*100} label="Right" color="#00c8e5"/>
                    </div>

                    <div className="flex flex-col gap-2">
                      <SectionLabel>System</SectionLabel>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Tile label="Uptime" value={formatUptime(diag.uptime)}/>
                        {diag.temp !== undefined && <Tile label="Temp" value={diag.temp.toFixed(1)} unit="°C" warn={diag.temp>70}/>}
                        {diag.signal !== undefined && <Tile label="Signal" value={`${diag.signal.toFixed(0)} dBm`}/>}
                        <Tile label="Frames" value={frameCount}/>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <SectionLabel>Bottleneck</SectionLabel>
                      <div className={`flex items-center gap-2 rounded p-2.5 border font-mono text-xs ${
                        diag.bottleneck!=='none'&&diag.bottleneck!==''
                          ? 'border-[#ff444433] bg-[#ff44440a] text-[#ff4444]'
                          : 'border-[#1a2d42] bg-[#0d1520] text-[#00cc66]'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${diag.bottleneck!=='none'&&diag.bottleneck!==''?'bg-[#ff4444]':'bg-[#00cc66]'}`}/>
                        {diag.bottleneck==='none'||diag.bottleneck==='' ? 'NOMINAL' : diag.bottleneck.toUpperCase()}
                      </div>
                    </div>
                  </div>
                )}

                {/* ══ CONFIG TAB ══ */}
                {tab === 'config' && (
                  <div className="flex flex-col gap-4 p-4">
                    {/* Protocol selector */}
                    <div className="flex flex-col gap-2">
                      <SectionLabel>Protocol</SectionLabel>
                      <div className="grid grid-cols-2 gap-1.5">
                        {(['websocket','mqtt'] as Protocol[]).map(p => (
                          <button key={p} onClick={() => setProtocol(p)}
                            className={`py-2 text-[10px] font-mono rounded border transition-colors ${
                              protocol===p
                                ? 'border-[#00e5ff55] bg-[#00e5ff0d] text-[#00e5ff]'
                                : 'border-[#1a2d42] text-slate-500 hover:text-slate-300'
                            }`}>
                            {p === 'websocket' ? 'WebSocket' : 'MQTT'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <Divider/>

                    {protocol === 'websocket' && (
                      <div className="flex flex-col gap-2">
                        <SectionLabel>WebSocket</SectionLabel>
                        {[['IP / Host', wsHost, setWsHost] as const, ['Port', wsPort, setWsPort] as const].map(([lbl,val,set]) => (
                          <div key={lbl} className="flex flex-col gap-1">
                            <label className="text-[9px] text-slate-500 font-mono">{lbl}</label>
                            <input value={val} onChange={e => set(e.target.value)}
                              disabled={connected&&!demoMode}
                              className="bg-[#0d1520] border border-[#1a2d42] rounded px-2.5 py-1.5 font-mono text-xs text-[#c8ddf0] outline-none focus:border-[#00e5ff] disabled:opacity-40 transition-colors"/>
                          </div>
                        ))}
                      </div>
                    )}

                    {protocol === 'mqtt' && (
                      <div className="flex flex-col gap-2">
                        <SectionLabel>MQTT Broker (WebSocket)</SectionLabel>
                        {[
                          ['Broker Host', mqttHost, setMqttHost] as const,
                          ['WS Port', mqttPort, setMqttPort] as const,
                          ['Data Topic', mqttDataTopic, setMqttDataTopic] as const,
                          ['Command Topic', mqttCmdTopic, setMqttCmdTopic] as const,
                        ].map(([lbl,val,set]) => (
                          <div key={lbl} className="flex flex-col gap-1">
                            <label className="text-[9px] text-slate-500 font-mono">{lbl}</label>
                            <input value={val} onChange={e => set(e.target.value)}
                              disabled={connected&&!demoMode}
                              className="bg-[#0d1520] border border-[#1a2d42] rounded px-2.5 py-1.5 font-mono text-xs text-[#c8ddf0] outline-none focus:border-[#00e5ff] disabled:opacity-40 transition-colors"/>
                          </div>
                        ))}
                        <p className="text-[9px] text-slate-600 leading-relaxed">
                          Cane publishes to the data topic. Server publishes settings/commands to the command topic.
                        </p>
                      </div>
                    )}

                    <div className="flex gap-2">
                      {!connected
                        ? <button onClick={connect}
                            className="flex-1 py-2 text-[11px] font-mono bg-[#00e5ff] text-[#080c10] rounded hover:bg-[#00b8cc] transition-colors font-semibold">
                            CONNECT
                          </button>
                        : <button onClick={disconnect}
                            className="flex-1 py-2 text-[11px] font-mono border border-[#ff444455] text-[#ff4444] rounded hover:bg-[#ff44440a] transition-colors">
                            DISCONNECT
                          </button>
                      }
                    </div>

                    <Divider/>
                    <button onClick={demoMode ? disconnect : startDemo}
                      className={`py-2 text-[11px] font-mono rounded border transition-colors ${
                        demoMode ? 'border-[#ffaa0055] text-[#ffaa00] hover:bg-[#ffaa000a]'
                          : 'border-[#1a2d42] text-slate-500 hover:border-[#2a4060] hover:text-slate-300'
                      }`}>
                      {demoMode ? 'STOP DEMO' : 'RUN DEMO'}
                    </button>

                    <Divider/>

                    {/* Frame format reference */}
                    <div className="flex flex-col gap-2">
                      <SectionLabel>Expected Frame Format</SectionLabel>
                      <pre className="text-[9px] font-mono text-slate-500 bg-[#0d1520] border border-[#1a2d42] rounded p-2.5 leading-relaxed overflow-x-auto whitespace-pre-wrap">
{`{
  "timestamp": 1721000000,
  "updates": [
    {"i": 5, "d": 1.23},
    {"i": 18, "d": 0.87}
  ],
  "motors": {
    "left": 0.75,
    "right": 0.0
  },
  "diagnostics": {
    "cpu": 42.5, "battery": 78,
    "refresh_rate": 30, "speed": 0.8,
    "bottleneck": "none",
    "uptime": 3600,
    "temp": 44.0, "signal": -65
  }
}`}
                      </pre>
                    </div>

                    <Divider/>

                    {/* Shutdown */}
                    {!shutdownConfirm
                      ? <button onClick={() => setShutdownConfirm(true)} disabled={!canSend}
                          className="w-full py-2 text-[11px] font-mono border border-[#ff444433] text-[#ff4444] rounded hover:bg-[#ff44440a] transition-colors disabled:opacity-20 disabled:cursor-not-allowed">
                          ⏻ REMOTE SHUTDOWN
                        </button>
                      : <div className="flex flex-col gap-2">
                          <p className="text-[10px] text-center text-[#ff4444] font-mono">Confirm shutdown?</p>
                          <div className="flex gap-2">
                            <button onClick={sendShutdown} disabled={shutdownSent}
                              className="flex-1 py-2 text-[11px] font-mono bg-[#ff4444] text-white rounded disabled:opacity-50">
                              {shutdownSent ? 'SENT...' : 'CONFIRM'}
                            </button>
                            <button onClick={() => setShutdownConfirm(false)}
                              className="flex-1 py-2 text-[11px] font-mono border border-[#1a2d42] text-slate-400 rounded hover:bg-[#0d1520] transition-colors">
                              CANCEL
                            </button>
                          </div>
                        </div>
                    }
                  </div>
                )}

                {/* ══ SETTINGS TAB ══ */}
                {tab === 'settings' && (
                  <div className="flex flex-col gap-5 p-4">
                    <p className="text-[9px] text-slate-500 leading-relaxed">Sent to cane as <code className="text-[#00e5ff] bg-[#0d1520] px-1 rounded">settings</code> command over the active connection.</p>

                    <div className="flex flex-col gap-3">
                      <SectionLabel>Motor Multipliers</SectionLabel>
                      <Slider label="Left ×" value={pendingSettings.motor_left_mult} min={0} max={2} step={0.05}
                        onChange={v => setPendingSettings(s => ({...s, motor_left_mult:v}))}/>
                      <Slider label="Right ×" value={pendingSettings.motor_right_mult} min={0} max={2} step={0.05}
                        onChange={v => setPendingSettings(s => ({...s, motor_right_mult:v}))}/>
                    </div>

                    <Divider/>

                    <div className="flex flex-col gap-3">
                      <SectionLabel>Sensor</SectionLabel>
                      <Slider label="Refresh Rate" value={pendingSettings.refresh_rate} min={1} max={60} step={1} unit=" Hz"
                        onChange={v => setPendingSettings(s => ({...s, refresh_rate:v}))}/>
                    </div>

                    <Divider/>

                    <div className="flex flex-col gap-3">
                      <SectionLabel>Vibration Distance Thresholds</SectionLabel>
                      <Slider label="Near threshold" value={pendingSettings.threshold_near} min={0.1} max={2.0} step={0.05} unit=" m"
                        onChange={v => setPendingSettings(s => ({...s, threshold_near:v}))}/>
                      <Slider label="Far threshold" value={pendingSettings.threshold_far} min={0.5} max={MAX_RANGE} step={0.1} unit=" m"
                        onChange={v => setPendingSettings(s => ({...s, threshold_far:v}))}/>
                      {/* Band diagram */}
                      <div className="relative h-2 rounded-full overflow-hidden bg-[#0d1f30]">
                        <div className="absolute h-full bg-[#ff333344] rounded-l-full"
                          style={{width:`${pendingSettings.threshold_near/MAX_RANGE*100}%`}}/>
                        <div className="absolute h-full bg-[#ffaa0033]"
                          style={{left:`${pendingSettings.threshold_near/MAX_RANGE*100}%`,
                            width:`${(pendingSettings.threshold_far-pendingSettings.threshold_near)/MAX_RANGE*100}%`}}/>
                      </div>
                      <div className="flex justify-between text-[9px] font-mono">
                        <span className="text-[#ff3333]">vibrate</span>
                        <span className="text-[#ffaa00]">ramp</span>
                        <span className="text-slate-600">quiet</span>
                      </div>
                    </div>

                    <Divider/>

                    <pre className="text-[9px] font-mono text-slate-500 bg-[#0d1520] border border-[#1a2d42] rounded p-2.5 leading-relaxed overflow-x-auto">
                      {JSON.stringify({command:'settings',settings:pendingSettings},null,2)}
                    </pre>

                    <div className="flex flex-col gap-2">
                      <button onClick={sendSettings} disabled={!canSend}
                        className={`py-2.5 text-[11px] font-mono rounded border transition-colors disabled:opacity-25 disabled:cursor-not-allowed ${
                          settingsSent ? 'border-[#00cc6655] bg-[#00cc660a] text-[#00cc66]'
                            : 'border-[#00e5ff55] text-[#00e5ff] hover:bg-[#00e5ff0a]'
                        }`}>
                        {settingsSent ? '✓ SENT' : 'SEND TO CANE'}
                      </button>
                      <button onClick={() => setPendingSettings(DEFAULT_SETTINGS)}
                        className="py-1.5 text-[10px] font-mono text-slate-600 hover:text-slate-400 transition-colors">
                        Reset to defaults
                      </button>
                    </div>
                  </div>
                )}

                {/* ══ FIRMWARE TAB ══ */}
                {tab === 'firmware' && (
                  <div className="flex flex-col gap-4 p-4">
                    <p className="text-[9px] text-slate-500 leading-relaxed">
                      Sends a <code className="text-[#00e5ff] bg-[#0d1520] px-1 rounded">firmware_start</code> JSON command followed by binary chunks over the active connection, then <code className="text-[#00e5ff] bg-[#0d1520] px-1 rounded">firmware_end</code>.
                    </p>

                    {/* Drop zone */}
                    <div
                      onDragOver={e => { e.preventDefault(); setFwDragging(true) }}
                      onDragLeave={() => setFwDragging(false)}
                      onDrop={handleFwDrop}
                      onClick={() => document.getElementById('fw-input')?.click()}
                      className={`flex flex-col items-center justify-center gap-2 rounded border-2 border-dashed p-6 cursor-pointer transition-all ${
                        fwDragging ? 'border-[#00e5ff] bg-[#00e5ff0a]' : 'border-[#1a2d42] hover:border-[#2a4060]'
                      }`}>
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className={fwDragging?'text-[#00e5ff]':'text-slate-600'}>
                        <path d="M14 4v14M14 4l-5 5M14 4l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M4 20v2a2 2 0 002 2h16a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                      <span className="text-[10px] font-mono text-slate-500">
                        {fwDragging ? 'Drop firmware file' : 'Drop .bin / .hex or click to browse'}
                      </span>
                      <input id="fw-input" type="file" accept=".bin,.hex,.elf,.fw" className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0]
                          if (f) { setFwFile(f); setFwStatus('idle'); setFwProgress(null) }
                        }}/>
                    </div>

                    {/* File info */}
                    {fwFile && (
                      <div className="flex items-center justify-between bg-[#0d1520] border border-[#1a2d42] rounded p-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono text-[11px] text-[#c8ddf0] truncate max-w-[140px]">{fwFile.name}</span>
                          <span className="font-mono text-[9px] text-slate-500">{fmtBytes(fwFile.size)}</span>
                        </div>
                        <button onClick={() => { setFwFile(null); setFwProgress(null); setFwStatus('idle') }}
                          className="text-slate-600 hover:text-[#ff4444] transition-colors text-lg leading-none">×</button>
                      </div>
                    )}

                    {/* Progress */}
                    {fwProgress !== null && (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex justify-between font-mono text-[9px]">
                          <span className={fwStatus==='done'?'text-[#00cc66]':fwStatus==='error'?'text-[#ff4444]':'text-[#00e5ff]'}>
                            {fwStatus==='done' ? '✓ COMPLETE' : fwStatus==='error' ? '✗ ERROR' : `UPLOADING ${fwProgress}%`}
                          </span>
                          {fwFile && <span className="text-slate-500">{fmtBytes(Math.round(fwFile.size*fwProgress/100))} / {fmtBytes(fwFile.size)}</span>}
                        </div>
                        <div className="h-1 rounded-full bg-[#0d1f30] overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-100"
                            style={{
                              width:`${fwProgress}%`,
                              background: fwStatus==='done'?'#00cc66':fwStatus==='error'?'#ff4444':'#00e5ff'
                            }}/>
                        </div>
                      </div>
                    )}

                    {/* Upload button */}
                    <button
                      onClick={uploadFirmware}
                      disabled={!canSend || !fwFile || fwStatus==='uploading'}
                      className={`py-2.5 text-[11px] font-mono rounded border transition-colors disabled:opacity-25 disabled:cursor-not-allowed ${
                        fwStatus==='done' ? 'border-[#00cc6655] text-[#00cc66]'
                          : fwStatus==='error' ? 'border-[#ff444455] text-[#ff4444]'
                          : 'border-[#00e5ff55] text-[#00e5ff] hover:bg-[#00e5ff0a]'
                      }`}>
                      {fwStatus==='uploading' ? `Uploading ${fwProgress}%…`
                        : fwStatus==='done' ? '✓ Upload Complete'
                        : fwStatus==='error' ? '✗ Failed — Retry'
                        : 'Upload Firmware'}
                    </button>

                    <Divider/>

                    {/* Command sequence preview */}
                    <div className="flex flex-col gap-2">
                      <SectionLabel>Command Sequence</SectionLabel>
                      <div className="flex flex-col gap-1 font-mono text-[9px] text-slate-500">
                        <div className="flex items-center gap-2">
                          <span className="text-[#00e5ff]">1.</span>
                          <span>{`{"command":"firmware_start","filename":"…","size":N}`}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[#ffaa00]">2.</span>
                          <span>Binary chunks (4 KB each)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[#00cc66]">3.</span>
                          <span>{`{"command":"firmware_end"}`}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </aside>

            {/* Drag handle */}
            <div
              onMouseDown={startDrag}
              className="w-1 cursor-ew-resize hover:bg-[#00e5ff33] active:bg-[#00e5ff55] transition-colors shrink-0"/>
          </div>
        )}

        {/* ── 3D Viewer ── */}
        <main className="flex-1 relative overflow-hidden">
          <Viewer3D depthBuffer={depthSnapshot} motors={motors} connected={connected}/>

          {/* Bottom stat strip */}
          {connected && (
            <div className="absolute bottom-0 inset-x-0 px-5 py-2 flex items-center gap-5 pointer-events-none bg-gradient-to-t from-[#080c10bb] to-transparent">
              <div className="flex gap-4 font-mono text-[11px] text-slate-500">
                <span>CPU <span className="text-[#00e5ff]">{diag.cpu.toFixed(1)}%</span></span>
                <span>BAT <span style={{color:diag.battery>50?'#00cc66':diag.battery>20?'#ffaa00':'#ff4444'}}>
                  {diag.battery.toFixed(0)}%
                </span></span>
                <span>FPS <span className="text-[#00e5ff]">{diag.refresh_rate.toFixed(1)}</span></span>
                {diag.bottleneck!=='none'&&diag.bottleneck!=='' &&
                  <span className="text-[#ff4444] animate-pulse">⚠ {diag.bottleneck.toUpperCase()}</span>}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
