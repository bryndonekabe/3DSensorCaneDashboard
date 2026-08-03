import { useState, useEffect, useRef, useCallback, useMemo, type DragEvent } from 'react'
import mqtt from 'mqtt'
import Viewer3D from './Viewer3D'
import type { CaneFrame, CaneSettings, ConnectionStatus, Diagnostics, MotorState, Protocol, DisplayMode } from './types'
import { MAX_RANGE, SENSOR_COLS, GRID_SIZE } from './types'
import { THEMES, DEFAULT_THEME, type Theme } from './themes'

// ─── Demo data ────────────────────────────────────────────────────────────────
function generateDemoFrame(t: number): CaneFrame {
  const updates: { i: number; d: number }[] = []
  for (let i = 0; i < GRID_SIZE; i++) {
    if (Math.random() > 0.6) continue
    const row = Math.floor(i / SENSOR_COLS), col = i % SENSOR_COLS
    const base = 2.2 + Math.sin(t * 0.5 + col * 0.4) * 0.7
    const obs = col >= 3 && col <= 4 && row >= 3 && row <= 5
      ? 0.7 + Math.abs(Math.sin(t * 1.2)) * 0.3 : base
    updates.push({ i, d: Math.max(0.1, obs + (Math.random() - 0.5) * 0.05) })
  }
  const lc = updates.some(u => u.i % SENSOR_COLS < 4 && u.d < 1.2)
  const rc = updates.some(u => u.i % SENSOR_COLS >= 4 && u.d < 1.2)
  return {
    timestamp: Date.now(), updates,
    motors: { left: lc ? Math.max(0, 0.55 + Math.sin(t*8)*0.3) : 0, right: rc ? Math.max(0, 0.55 + Math.sin(t*8+1)*0.3) : 0 },
    diagnostics: {
      cpu: 36 + Math.sin(t*.7)*14, battery: Math.max(0, 82 - t*.008),
      refresh_rate: 28 + Math.random()*4, speed: Math.abs(Math.sin(t*.4))*1.1,
      bottleneck: t%18 < 1.5 ? 'sensor' : 'none', uptime: Math.floor(t),
      temp: 41 + Math.sin(t*.5)*5, signal: -60 + Math.sin(t*.9)*8,
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (s: number) => `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`
const fmtB = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(2)} MB`

// ─── Atom components (themed) ─────────────────────────────────────────────────
function StatusDot({ status, theme }: { status: ConnectionStatus; theme: Theme }) {
  const color = status==='connected'?'#00cc66':status==='connecting'?'#ffaa00':status==='error'?'#ff4444':theme.border
  const pulse = status==='connected'||status==='connecting'
  return (
    <span className="relative inline-flex w-2.5 h-2.5 items-center justify-center shrink-0">
      {pulse && <span className="absolute w-full h-full rounded-full opacity-40 animate-ping" style={{background:color}}/>}
      <span className="relative w-2 h-2 rounded-full" style={{background:color}}/>
    </span>
  )
}

function GaugeBar({ value, max=100, color, label, unit='%', theme }: { value:number; max?:number; color:string; label:string; unit?:string; theme:Theme }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] uppercase tracking-widest" style={{color:theme.muted}}>{label}</span>
        <span className="font-mono text-[11px]" style={{color}}>{value.toFixed(1)}{unit}</span>
      </div>
      <div className="h-0.5 rounded-full overflow-hidden" style={{background:theme.panelBg2}}>
        <div className="h-full rounded-full transition-all duration-200" style={{width:`${Math.min(value/max*100,100)}%`,background:color}}/>
      </div>
    </div>
  )
}

function Tile({ label, value, unit, warn=false, theme }: { label:string; value:string|number; unit?:string; warn?:boolean; theme:Theme }) {
  return (
    <div className="flex flex-col gap-0.5 rounded p-2" style={{border:`1px solid ${warn?'rgba(255,68,68,0.2)':theme.border}`,background:warn?'rgba(255,68,68,0.04)':theme.panelBg}}>
      <span className="text-[9px] uppercase tracking-widest" style={{color:theme.muted}}>{label}</span>
      <span className="font-mono text-xs leading-tight" style={{color:warn?'#ff4444':theme.text}}>
        {value}{unit&&<span className="text-[10px] ml-0.5" style={{color:theme.muted}}>{unit}</span>}
      </span>
    </div>
  )
}

function Slider({ label, value, min, max, step=0.01, unit, onChange, theme }: {
  label:string; value:number; min:number; max:number; step?:number; unit?:string; onChange:(v:number)=>void; theme:Theme
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] uppercase tracking-widest" style={{color:theme.muted}}>{label}</span>
        <span className="font-mono text-[11px]" style={{color:theme.accent}}>{value.toFixed(step<0.1?2:0)}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e=>onChange(Number(e.target.value))}
        className="w-full h-0.5 appearance-none rounded cursor-pointer" style={{accentColor:theme.accent,background:theme.panelBg2}}/>
    </div>
  )
}

function BatteryIcon({ pct }: { pct: number }) {
  const color = pct>50?'#00cc66':pct>20?'#ffaa00':'#ff4444'
  return (
    <svg width="24" height="12" viewBox="0 0 24 12" fill="none" className="shrink-0">
      <rect x=".5" y=".5" width="20" height="11" rx="2" stroke={color} strokeOpacity=".5"/>
      <rect x="1" y="1" width={Math.round(18*pct/100)} height="10" rx="1.5" fill={color} fillOpacity=".85"/>
      <rect x="21" y="3" width="2.5" height="5" rx="1" fill={color} fillOpacity=".4"/>
    </svg>
  )
}

function ThemedInput({ value, onChange, disabled, placeholder }: { value:string; onChange:(v:string)=>void; disabled?:boolean; placeholder?:string }) {
  return (
    <input value={value} onChange={e=>onChange(e.target.value)} disabled={disabled} placeholder={placeholder}
      className="w-full rounded px-2.5 py-1.5 font-mono text-xs outline-none transition-colors disabled:opacity-40"
      style={{background:'#0d1520',border:'1px solid #1a2d42',color:'#c8ddf0'}}
    />
  )
}

function SL({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  return <span className="text-[9px] uppercase tracking-widest" style={{color:theme.muted}}>{children}</span>
}
function Div({ theme }: { theme: Theme }) {
  return <div style={{ height: 1, background: theme.border }}/>
}

// ─── Constants ────────────────────────────────────────────────────────────────
const EMPTY_DIAG: Diagnostics = { cpu:0, battery:100, refresh_rate:0, speed:0, bottleneck:'none', uptime:0 }
const EMPTY_MOTORS: MotorState = { left:0, right:0 }
const DEFAULT_SETTINGS: CaneSettings = { motor_left_mult:1.0, motor_right_mult:1.0, refresh_rate:30, threshold_near:0.8, threshold_far:2.5 }
const TABS = ['diag','config','settings','theme','firmware'] as const
type Tab = typeof TABS[number]
const TAB_LABELS: Record<Tab,string> = { diag:'Diag', config:'Connect', settings:'Tune', theme:'Theme', firmware:'FW' }

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
  const depthBuf = useRef<Float32Array>(new Float32Array(GRID_SIZE).fill(NaN))
  const [depthVer, setDepthVer] = useState(0)
  const depthSnap = useMemo(() => new Float32Array(depthBuf.current), [depthVer]) // eslint-disable-line
  const [motors, setMotors] = useState<MotorState>(EMPTY_MOTORS)
  const [diag, setDiag] = useState<Diagnostics>(EMPTY_DIAG)
  const [frameCount, setFrameCount] = useState(0)
  const [lastTs, setLastTs] = useState<number|null>(null)

  // UI
  const [tab, setTab] = useState<Tab>('config')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarW, setSidebarW] = useState(280)
  const dragState = useRef<{active:boolean;sx:number;sw:number}>({active:false,sx:0,sw:280})

  // Display & theme
  const [displayMode, setDisplayMode] = useState<DisplayMode>('spheres')
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME)
  const [customTheme, setCustomTheme] = useState<Theme>(DEFAULT_THEME)
  const [useCustom, setUseCustom] = useState(false)
  const activeTheme = useCustom ? customTheme : theme

  // Settings
  const [pendingSettings, setPendingSettings] = useState<CaneSettings>(DEFAULT_SETTINGS)
  const [settingsSent, setSettingsSent] = useState(false)
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
  const demoTimer = useRef<ReturnType<typeof setInterval>|null>(null)
  const demoTime = useRef(0)

  // Sidebar drag resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.active) return
      setSidebarW(Math.max(200, Math.min(520, dragState.current.sw + e.clientX - dragState.current.sx)))
    }
    const onUp = () => { dragState.current.active = false; document.body.style.cursor = '' }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const startSidebarDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    dragState.current = { active: true, sx: e.clientX, sw: sidebarW }
    document.body.style.cursor = 'ew-resize'
  }

  const applyFrame = useCallback((frame: CaneFrame) => {
console.log(
    "received",
    frame.updates.length,
    "first",
    frame.updates.slice(0,5),
    "last",
    frame.updates.slice(-5)
  )
    for (const {i,d} of frame.updates) { if (i>=0&&i<GRID_SIZE) depthBuf.current[i]=d }
    setDepthVer(v=>v+1); setMotors(frame.motors); setDiag(frame.diagnostics)
    setLastTs(frame.timestamp); setFrameCount(c=>c+1)
  }, [])

  const resetData = useCallback(() => {
    depthBuf.current.fill(NaN); setDepthVer(v=>v+1)
    setMotors(EMPTY_MOTORS); setDiag(EMPTY_DIAG); setFrameCount(0); setLastTs(null)
  }, [])

  const sendRaw = useCallback((payload: string|ArrayBuffer) => {
    if (wsRef.current?.readyState===WebSocket.OPEN) wsRef.current.send(payload)
    else if (mqttRef.current?.connected && typeof payload==='string') mqttRef.current.publish(mqttCmdTopic, payload)
  }, [mqttCmdTopic])

  const sendCmd = useCallback((obj: object) => sendRaw(JSON.stringify(obj)), [sendRaw])

  const disconnect = useCallback(() => {
    wsRef.current?.close(); wsRef.current = null
    mqttRef.current?.end(true); mqttRef.current = null
    if (demoTimer.current) { clearInterval(demoTimer.current); demoTimer.current = null }
    setDemoMode(false); setStatus('disconnected'); resetData()
  }, [resetData])

  const connectWS = useCallback(() => {
    disconnect(); setStatus('connecting')
    const ws = new WebSocket(`ws://${wsHost}:${wsPort}`)
    wsRef.current = ws
    ws.onopen = () => setStatus('connected')
    ws.onclose = () => { setStatus('disconnected'); wsRef.current = null }
    ws.onerror = () => setStatus('error')
    ws.onmessage = evt => { try { applyFrame(JSON.parse(evt.data)) } catch {} }
  }, [wsHost, wsPort, disconnect, applyFrame])

  const connectMQTT = useCallback(() => {
    disconnect(); setStatus('connecting')
    const client = mqtt.connect(`ws://${mqttHost}:${mqttPort}`, { reconnectPeriod: 0 })
    mqttRef.current = client
    client.on('connect', () => { setStatus('connected'); client.subscribe(mqttDataTopic) })
    client.on('message', (_t, p) => { try { applyFrame(JSON.parse(p.toString())) } catch {} })
    client.on('error', () => setStatus('error'))
    client.on('close', () => { setStatus('disconnected'); mqttRef.current = null })
  }, [mqttHost, mqttPort, mqttDataTopic, disconnect, applyFrame])

  const connect = useCallback(() => {
    protocol === 'websocket' ? connectWS() : connectMQTT()
  }, [protocol, connectWS, connectMQTT])

  const startDemo = useCallback(() => {
    disconnect(); setDemoMode(true); setStatus('connected'); demoTime.current = 0
    demoTimer.current = setInterval(() => { demoTime.current += 1/15; applyFrame(generateDemoFrame(demoTime.current)) }, 67)
  }, [disconnect, applyFrame])

  const sendSettings = useCallback(() => {
    sendCmd({ command:'settings', settings:pendingSettings }); setSettingsSent(true)
    setTimeout(() => setSettingsSent(false), 1800)
  }, [sendCmd, pendingSettings])

  const sendShutdown = useCallback(() => {
    sendCmd({ command:'shutdown' }); setShutdownSent(true)
    setTimeout(() => { disconnect(); setShutdownSent(false); setShutdownConfirm(false) }, 1500)
  }, [sendCmd, disconnect])

  const uploadFw = useCallback(async () => {
    if (!fwFile) return
    setFwStatus('uploading'); setFwProgress(0)
    try {
      const buf = await fwFile.arrayBuffer()
      sendCmd({ command:'firmware_start', filename:fwFile.name, size:fwFile.size })
      await new Promise(r=>setTimeout(r,80))
      const CHUNK = 4096
      for (let off = 0; off < buf.byteLength; off += CHUNK) {
        sendRaw(buf.slice(off, off+CHUNK))
        setFwProgress(Math.round(Math.min(off+CHUNK,buf.byteLength)/buf.byteLength*100))
        await new Promise(r=>setTimeout(r,12))
      }
      sendCmd({ command:'firmware_end' }); setFwStatus('done')
    } catch { setFwStatus('error') }
  }, [fwFile, sendCmd, sendRaw])

  useEffect(() => () => {
    if (demoTimer.current) clearInterval(demoTimer.current)
    wsRef.current?.close(); mqttRef.current?.end(true)
  }, [])

  const connected = status === 'connected'
  const canSend = connected && !demoMode
  const T = activeTheme

  // Tab button style
  const tabCls = (t: Tab) => ({
    flex: '1 1 0', padding: '8px 2px', fontSize: 9, fontFamily: 'monospace',
    textTransform: 'uppercase' as const, letterSpacing: '0.1em',
    borderBottom: tab===t ? `1px solid ${T.accent}` : 'none',
    color: tab===t ? T.accent : T.muted,
    background: 'transparent', cursor: 'pointer', transition: 'color 0.15s',
    marginBottom: tab===t ? -1 : 0,
  })

  // Text input style
  const inputStyle = { background: T.panelBg, border: `1px solid ${T.border}`, color: T.text, borderRadius: 4, padding: '6px 10px', fontFamily: 'monospace', fontSize: 12, outline: 'none', width: '100%' }

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: T.surfaceBg, color: T.text }}>
      {/* ── Top bar ── */}
      <header className="flex items-center gap-3 px-4 shrink-0" style={{ height: 44, borderBottom: `1px solid ${T.border}` }}>
        <button onClick={() => setSidebarOpen(o=>!o)}
          className="flex items-center justify-center w-7 h-7 rounded transition-colors shrink-0"
          style={{ border:`1px solid ${T.border}`, color:T.muted }}>
          <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
            <rect width="12" height="1.5" rx=".75" fill="currentColor"/>
            <rect y="4" width="12" height="1.5" rx=".75" fill="currentColor"/>
            <rect y="8" width="12" height="1.5" rx=".75" fill="currentColor"/>
          </svg>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <svg width="13" height="16" viewBox="0 0 13 16" fill="none">
            <path d="M6.5 1v14M6.5 1C6.5 1 2 5 2 8.5M6.5 1C6.5 1 11 5 11 8.5" stroke={T.accent} strokeWidth="1.2" strokeLinecap="round"/>
            <circle cx="6.5" cy="15" r="1.5" fill={T.accent} fillOpacity=".6"/>
          </svg>
          <span className="font-mono text-sm tracking-widest" style={{ color: T.accent }}>PATHFINDER</span>
          <span className="font-mono text-[10px]" style={{ color: T.muted }}>Dashboard</span>
        </div>

        {/* Display mode pills */}
        <div className="flex gap-1 ml-2 shrink-0">
          {(['dots','spheres','mesh'] as DisplayMode[]).map(m => (
            <button key={m} onClick={() => setDisplayMode(m)}
              className="px-2.5 py-1 rounded font-mono text-[9px] uppercase tracking-wider transition-colors"
              style={{
                border: `1px solid ${displayMode===m ? T.accent : T.border}`,
                background: displayMode===m ? `${T.accent}15` : 'transparent',
                color: displayMode===m ? T.accent : T.muted,
              }}>
              {m}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 font-mono text-[11px] ml-1">
          <StatusDot status={status} theme={T}/>
          <span style={{ color: status==='connected'?'#00cc66':status==='connecting'?'#ffaa00':status==='error'?'#ff4444':T.muted }}>
            {demoMode ? 'DEMO' : status.toUpperCase()}
          </span>
          {connected && <>
            <span style={{color:T.border}}>|</span>
            <span style={{color:T.muted}}><span style={{color:T.accent}}>{diag.refresh_rate.toFixed(1)}</span> Hz</span>
            <span style={{color:T.border}}>|</span>
            <span style={{color:T.muted}}><span style={{color:T.accent}}>{frameCount}</span> frames</span>
          </>}
        </div>

        <div style={{ flex: 1 }}/>
        {connected && (
          <div className="flex items-center gap-3 font-mono text-[11px] shrink-0" style={{color:T.muted}}>
            <BatteryIcon pct={diag.battery}/>
            <span>CPU <span style={{color:T.accent}}>{diag.cpu.toFixed(0)}%</span></span>
            {diag.bottleneck!=='none'&&diag.bottleneck!=='' && <span className="animate-pulse" style={{color:'#ff4444'}}>⚠ {diag.bottleneck.toUpperCase()}</span>}
          </div>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar ── */}
        {sidebarOpen && (
          <div className="flex shrink-0 overflow-hidden" style={{ width: sidebarW }}>
            <aside className="flex flex-col flex-1 overflow-hidden" style={{ borderRight: `1px solid ${T.border}` }}>
              {/* Tabs */}
              <div className="flex shrink-0" style={{ borderBottom: `1px solid ${T.border}` }}>
                {TABS.map(t => <button key={t} onClick={()=>setTab(t)} style={tabCls(t)}>{TAB_LABELS[t]}</button>)}
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

                {/* ══ DIAG ══ */}
                {tab==='diag' && <>
                  <div className="flex flex-col gap-2">
                    <SL theme={T}>Power</SL>
                    <div className="flex items-center gap-3 rounded p-3" style={{border:`1px solid ${T.border}`,background:T.panelBg}}>
                      <BatteryIcon pct={diag.battery}/>
                      <div className="flex flex-col">
                        <span className="font-mono text-xl leading-none" style={{color:diag.battery>50?'#00cc66':diag.battery>20?'#ffaa00':'#ff4444'}}>{diag.battery.toFixed(0)}%</span>
                        <span className="text-[9px]" style={{color:T.muted}}>Battery</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    <SL theme={T}>Performance</SL>
                    <GaugeBar value={diag.cpu} label="CPU" color={diag.cpu>80?'#ff4444':diag.cpu>60?'#ffaa00':T.accent} theme={T}/>
                    <GaugeBar value={diag.refresh_rate} max={60} label="Refresh" unit=" Hz" color="#00cc66" theme={T}/>
                    <GaugeBar value={diag.speed} max={2} label="Speed" unit=" m/s" color={T.accent} theme={T}/>
                  </div>

                  <div className="flex flex-col gap-3">
                    <SL theme={T}>Motors</SL>
                    <GaugeBar value={motors.left*100} label="Left" color={T.accent} theme={T}/>
                    <GaugeBar value={motors.right*100} label="Right" color={T.accentDim} theme={T}/>
                  </div>

                  <div className="flex flex-col gap-2">
                    <SL theme={T}>System</SL>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Tile label="Uptime" value={fmt(diag.uptime)} theme={T}/>
                      {diag.temp!==undefined&&<Tile label="Temp" value={diag.temp.toFixed(1)} unit="°C" warn={diag.temp>70} theme={T}/>}
                      {diag.signal!==undefined&&<Tile label="Signal" value={`${diag.signal.toFixed(0)} dBm`} theme={T}/>}
                      <Tile label="Frames" value={frameCount} theme={T}/>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <SL theme={T}>Bottleneck</SL>
                    <div className="flex items-center gap-2 rounded p-2.5 font-mono text-xs"
                      style={{
                        border:`1px solid ${diag.bottleneck!=='none'&&diag.bottleneck!==''?'rgba(255,68,68,0.2)':T.border}`,
                        background:diag.bottleneck!=='none'&&diag.bottleneck!==''?'rgba(255,68,68,0.04)':T.panelBg,
                        color:diag.bottleneck!=='none'&&diag.bottleneck!==''?'#ff4444':'#00cc66',
                      }}>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{background:diag.bottleneck!=='none'&&diag.bottleneck!==''?'#ff4444':'#00cc66'}}/>
                      {diag.bottleneck==='none'||diag.bottleneck===''?'NOMINAL':diag.bottleneck.toUpperCase()}
                    </div>
                  </div>
                </>}

                {/* ══ CONFIG ══ */}
                {tab==='config' && <>
                  <div className="flex flex-col gap-2">
                    <SL theme={T}>Protocol</SL>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(['websocket','mqtt'] as Protocol[]).map(p => (
                        <button key={p} onClick={()=>setProtocol(p)}
                          className="py-2 font-mono rounded transition-colors"
                          style={{fontSize:10,border:`1px solid ${protocol===p?T.accent:T.border}`,background:protocol===p?`${T.accent}15`:'transparent',color:protocol===p?T.accent:T.muted}}>
                          {p==='websocket'?'WebSocket':'MQTT'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <Div theme={T}/>

                  {protocol==='websocket' && (
                    <div className="flex flex-col gap-2">
                      <SL theme={T}>WebSocket</SL>
                      {[['Host / IP', wsHost, setWsHost], ['Port', wsPort, setWsPort]].map(([lbl,val,set]) => (
                        <div key={lbl as string} className="flex flex-col gap-1">
                          <label className="text-[9px] font-mono" style={{color:T.muted}}>{lbl as string}</label>
                          <input value={val as string} onChange={e=>(set as (v:string)=>void)(e.target.value)}
                            disabled={connected&&!demoMode} style={inputStyle}/>
                        </div>
                      ))}
                    </div>
                  )}

                  {protocol==='mqtt' && (
                    <div className="flex flex-col gap-2">
                      <SL theme={T}>MQTT over WebSocket</SL>
                      {[
                        ['Broker Host', mqttHost, setMqttHost],
                        ['WS Port', mqttPort, setMqttPort],
                        ['Data Topic', mqttDataTopic, setMqttDataTopic],
                        ['Command Topic', mqttCmdTopic, setMqttCmdTopic],
                      ].map(([lbl,val,set]) => (
                        <div key={lbl as string} className="flex flex-col gap-1">
                          <label className="text-[9px] font-mono" style={{color:T.muted}}>{lbl as string}</label>
                          <input value={val as string} onChange={e=>(set as (v:string)=>void)(e.target.value)}
                            disabled={connected&&!demoMode} style={inputStyle}/>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    {!connected
                      ? <button onClick={connect} className="flex-1 py-2 font-mono rounded font-semibold transition-colors"
                          style={{fontSize:11,background:T.accent,color:T.surfaceBg}}>CONNECT</button>
                      : <button onClick={disconnect} className="flex-1 py-2 font-mono rounded transition-colors"
                          style={{fontSize:11,border:'1px solid rgba(255,68,68,0.35)',color:'#ff4444'}}>DISCONNECT</button>
                    }
                  </div>

                  <Div theme={T}/>
                  <button onClick={demoMode?disconnect:startDemo} className="py-2 font-mono rounded transition-colors"
                    style={{fontSize:11,border:`1px solid ${demoMode?'rgba(255,170,0,0.35)':T.border}`,color:demoMode?'#ffaa00':T.muted}}>
                    {demoMode?'STOP DEMO':'RUN DEMO'}
                  </button>

                  <Div theme={T}/>

                  <div className="flex flex-col gap-2">
                    <SL theme={T}>Frame Format</SL>
                    <pre className="text-[9px] font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap rounded p-2.5"
                      style={{background:T.panelBg,border:`1px solid ${T.border}`,color:T.muted}}>
{`{ "timestamp": 1721000000,
  "updates": [{"i":5,"d":1.23}],
  "motors": {"left":0.75,"right":0.0},
  "diagnostics": {
    "cpu":42, "battery":78,
    "refresh_rate":30, "speed":0.8,
    "bottleneck":"none", "uptime":3600,
    "temp":44, "signal":-65 } }`}
                    </pre>
                  </div>

                  <Div theme={T}/>
                  {!shutdownConfirm
                    ? <button onClick={()=>setShutdownConfirm(true)} disabled={!canSend}
                        className="w-full py-2 font-mono rounded transition-colors disabled:opacity-20"
                        style={{fontSize:11,border:'1px solid rgba(255,68,68,0.25)',color:'#ff4444'}}>⏻ REMOTE SHUTDOWN</button>
                    : <div className="flex flex-col gap-2">
                        <p className="text-[10px] text-center font-mono" style={{color:'#ff4444'}}>Confirm shutdown?</p>
                        <div className="flex gap-2">
                          <button onClick={sendShutdown} disabled={shutdownSent}
                            className="flex-1 py-2 font-mono rounded disabled:opacity-50" style={{fontSize:11,background:'#ff4444',color:'#fff'}}>
                            {shutdownSent?'SENT…':'CONFIRM'}
                          </button>
                          <button onClick={()=>setShutdownConfirm(false)} className="flex-1 py-2 font-mono rounded transition-colors"
                            style={{fontSize:11,border:`1px solid ${T.border}`,color:T.muted}}>CANCEL</button>
                        </div>
                      </div>
                  }
                </>}

                {/* ══ SETTINGS ══ */}
                {tab==='settings' && <>
                  <p className="text-[9px] leading-relaxed" style={{color:T.muted}}>
                    Sent to cane as <code className="rounded px-1" style={{background:T.panelBg,color:T.accent}}>settings</code> command.
                  </p>
                  <div className="flex flex-col gap-3">
                    <SL theme={T}>Motor Multipliers</SL>
                    <Slider label="Left ×" value={pendingSettings.motor_left_mult} min={0} max={2} step={0.05} theme={T} onChange={v=>setPendingSettings(s=>({...s,motor_left_mult:v}))}/>
                    <Slider label="Right ×" value={pendingSettings.motor_right_mult} min={0} max={2} step={0.05} theme={T} onChange={v=>setPendingSettings(s=>({...s,motor_right_mult:v}))}/>
                  </div>
                  <Div theme={T}/>
                  <div className="flex flex-col gap-3">
                    <SL theme={T}>Sensor</SL>
                    <Slider label="Refresh Rate" value={pendingSettings.refresh_rate} min={1} max={60} step={1} unit=" Hz" theme={T} onChange={v=>setPendingSettings(s=>({...s,refresh_rate:v}))}/>
                  </div>
                  <Div theme={T}/>
                  <div className="flex flex-col gap-3">
                    <SL theme={T}>Vibration Thresholds</SL>
                    <Slider label="Near threshold" value={pendingSettings.threshold_near} min={0.1} max={2.0} step={0.05} unit=" m" theme={T} onChange={v=>setPendingSettings(s=>({...s,threshold_near:v}))}/>
                    <Slider label="Far threshold" value={pendingSettings.threshold_far} min={0.5} max={MAX_RANGE} step={0.1} unit=" m" theme={T} onChange={v=>setPendingSettings(s=>({...s,threshold_far:v}))}/>
                    <div className="relative h-2 rounded-full overflow-hidden" style={{background:T.panelBg2}}>
                      <div className="absolute h-full rounded-l-full" style={{width:`${pendingSettings.threshold_near/MAX_RANGE*100}%`,background:'rgba(255,51,51,0.35)'}}/>
                      <div className="absolute h-full" style={{left:`${pendingSettings.threshold_near/MAX_RANGE*100}%`,width:`${(pendingSettings.threshold_far-pendingSettings.threshold_near)/MAX_RANGE*100}%`,background:'rgba(255,170,0,0.25)'}}/>
                    </div>
                    <div className="flex justify-between text-[9px] font-mono">
                      <span style={{color:'#ff3333'}}>vibrate</span>
                      <span style={{color:'#ffaa00'}}>ramp</span>
                      <span style={{color:T.muted}}>quiet</span>
                    </div>
                  </div>
                  <Div theme={T}/>
                  <pre className="text-[9px] font-mono leading-relaxed overflow-x-auto rounded p-2.5"
                    style={{background:T.panelBg,border:`1px solid ${T.border}`,color:T.muted}}>
                    {JSON.stringify({command:'settings',settings:pendingSettings},null,2)}
                  </pre>
                  <div className="flex flex-col gap-2">
                    <button onClick={sendSettings} disabled={!canSend}
                      className="py-2.5 font-mono rounded transition-colors disabled:opacity-25"
                      style={{fontSize:11,border:`1px solid ${settingsSent?'rgba(0,204,102,0.4)':T.accent+'88'}`,background:settingsSent?'rgba(0,204,102,0.06)':'transparent',color:settingsSent?'#00cc66':T.accent}}>
                      {settingsSent?'✓ SENT':'SEND TO CANE'}
                    </button>
                    <button onClick={()=>setPendingSettings(DEFAULT_SETTINGS)}
                      className="py-1.5 font-mono transition-colors" style={{fontSize:10,color:T.muted}}>
                      Reset to defaults
                    </button>
                  </div>
                </>}

                {/* ══ THEME ══ */}
                {tab==='theme' && <>
                  <div className="flex flex-col gap-2">
                    <SL theme={T}>Preset Themes</SL>
                    <div className="grid grid-cols-1 gap-1.5">
                      {THEMES.map(th => (
                        <button key={th.id} onClick={()=>{ setTheme(th); setUseCustom(false) }}
                          className="flex items-center gap-3 px-3 py-2.5 rounded transition-colors text-left"
                          style={{border:`1px solid ${!useCustom&&theme.id===th.id?T.accent:T.border}`,background:!useCustom&&theme.id===th.id?`${T.accent}10`:T.panelBg}}>
                          {/* Color swatch strip */}
                          <div className="flex gap-0.5 shrink-0">
                            {[th.nearColor,th.midColor,th.farColor].map((c,i) => (
                              <span key={i} className="w-3 h-5 rounded-sm inline-block"
                                style={{background:`#${c.toString(16).padStart(6,'0')}`}}/>
                            ))}
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-mono text-[11px]" style={{color:!useCustom&&theme.id===th.id?T.accent:T.text}}>{th.name}</span>
                            <span className="font-mono text-[9px]" style={{color:T.muted}}>{th.accent}</span>
                          </div>
                          {!useCustom&&theme.id===th.id&&<span className="ml-auto text-[9px] font-mono" style={{color:T.accent}}>ACTIVE</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  <Div theme={T}/>

                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <SL theme={T}>Custom Theme</SL>
                      <button onClick={()=>setUseCustom(u=>!u)}
                        className="font-mono text-[9px] rounded px-2 py-1 transition-colors"
                        style={{border:`1px solid ${useCustom?T.accent:T.border}`,color:useCustom?T.accent:T.muted,background:useCustom?`${T.accent}10`:'transparent'}}>
                        {useCustom?'ACTIVE':'USE'}
                      </button>
                    </div>

                    {/* Color pickers */}
                    {([ ['Accent color', 'accent'], ['Near (close)', 'nearColor'], ['Mid', 'midColor'], ['Far (max range)', 'farColor'], ] as [string,keyof Theme][]).map(([lbl,key]) => {
                      const hexVal = typeof customTheme[key]==='number'
                        ? `#${(customTheme[key] as number).toString(16).padStart(6,'0')}`
                        : customTheme[key] as string
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <label className="text-[9px] font-mono flex-1" style={{color:T.muted}}>{lbl}</label>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[9px]" style={{color:T.muted}}>{hexVal}</span>
                            <input type="color" value={hexVal}
                              onChange={e => {
                                const hex = e.target.value
                                const num = parseInt(hex.slice(1), 16)
                                setCustomTheme(ct => ({
                                  ...ct,
                                  [key]: typeof ct[key]==='number' ? num : hex,
                                  panelBg: ct.surfaceBg,
                                }))
                              }}
                              className="w-7 h-7 rounded cursor-pointer border-0 p-0"
                              style={{background:'transparent'}}/>
                          </div>
                        </div>
                      )
                    })}

                    <button onClick={()=>setCustomTheme({...T, id:'custom', name:'Custom'})}
                      className="py-1.5 font-mono transition-colors" style={{fontSize:10,color:T.muted}}>
                      Copy from current preset
                    </button>
                  </div>
                </>}

                {/* ══ FIRMWARE ══ */}
                {tab==='firmware' && <>
                  <p className="text-[9px] leading-relaxed" style={{color:T.muted}}>
                    Sends <code className="rounded px-1" style={{background:T.panelBg,color:T.accent}}>firmware_start</code> → binary chunks → <code className="rounded px-1" style={{background:T.panelBg,color:T.accent}}>firmware_end</code>.
                  </p>

                  {/* Drop zone */}
                  <div
                    onDragOver={e=>{e.preventDefault();setFwDragging(true)}}
                    onDragLeave={()=>setFwDragging(false)}
                    onDrop={(e:DragEvent<HTMLDivElement>)=>{e.preventDefault();setFwDragging(false);const f=e.dataTransfer.files[0];if(f){setFwFile(f);setFwStatus('idle');setFwProgress(null)}}}
                    onClick={()=>document.getElementById('fw-input')?.click()}
                    className="flex flex-col items-center justify-center gap-2 rounded cursor-pointer transition-all p-6"
                    style={{border:`2px dashed ${fwDragging?T.accent:T.border}`,background:fwDragging?`${T.accent}08`:'transparent'}}>
                    <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                      <path d="M13 3v13M13 3l-5 5M13 3l5 5" stroke={fwDragging?T.accent:T.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M3 19v2a2 2 0 002 2h16a2 2 0 002-2v-2" stroke={fwDragging?T.accent:T.muted} strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span className="text-[10px] font-mono text-center" style={{color:T.muted}}>
                      {fwDragging?'Drop firmware':'Drop .bin / .hex or click'}
                    </span>
                    <input id="fw-input" type="file" accept=".bin,.hex,.elf,.fw" className="hidden"
                      onChange={e=>{const f=e.target.files?.[0];if(f){setFwFile(f);setFwStatus('idle');setFwProgress(null)}}}/>
                  </div>

                  {fwFile && (
                    <div className="flex items-center justify-between rounded p-3" style={{border:`1px solid ${T.border}`,background:T.panelBg}}>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-[11px] truncate max-w-[150px]" style={{color:T.text}}>{fwFile.name}</span>
                        <span className="font-mono text-[9px]" style={{color:T.muted}}>{fmtB(fwFile.size)}</span>
                      </div>
                      <button onClick={()=>{setFwFile(null);setFwProgress(null);setFwStatus('idle')}}
                        className="text-lg leading-none transition-colors" style={{color:T.muted}}>×</button>
                    </div>
                  )}

                  {fwProgress!==null && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between font-mono text-[9px]">
                        <span style={{color:fwStatus==='done'?'#00cc66':fwStatus==='error'?'#ff4444':T.accent}}>
                          {fwStatus==='done'?'✓ COMPLETE':fwStatus==='error'?'✗ ERROR':`UPLOADING ${fwProgress}%`}
                        </span>
                        {fwFile&&<span style={{color:T.muted}}>{fmtB(Math.round(fwFile.size*fwProgress/100))} / {fmtB(fwFile.size)}</span>}
                      </div>
                      <div className="h-1 rounded-full overflow-hidden" style={{background:T.panelBg2}}>
                        <div className="h-full rounded-full transition-all duration-100"
                          style={{width:`${fwProgress}%`,background:fwStatus==='done'?'#00cc66':fwStatus==='error'?'#ff4444':T.accent}}/>
                      </div>
                    </div>
                  )}

                  <button onClick={uploadFw} disabled={!canSend||!fwFile||fwStatus==='uploading'}
                    className="py-2.5 font-mono rounded transition-colors disabled:opacity-25"
                    style={{fontSize:11,border:`1px solid ${fwStatus==='done'?'rgba(0,204,102,0.4)':fwStatus==='error'?'rgba(255,68,68,0.4)':T.accent+'88'}`,
                      color:fwStatus==='done'?'#00cc66':fwStatus==='error'?'#ff4444':T.accent}}>
                    {fwStatus==='uploading'?`Uploading ${fwProgress}%…`:fwStatus==='done'?'✓ Upload Complete':fwStatus==='error'?'✗ Failed — Retry':'Upload Firmware'}
                  </button>

                  <Div theme={T}/>
                  <div className="flex flex-col gap-2">
                    <SL theme={T}>Command Sequence</SL>
                    <div className="flex flex-col gap-1 font-mono text-[9px]" style={{color:T.muted}}>
                      <div><span style={{color:T.accent}}>1.</span> {`{"command":"firmware_start","size":N}`}</div>
                      <div><span style={{color:'#ffaa00'}}>2.</span> Binary chunks (4 KB each)</div>
                      <div><span style={{color:'#00cc66'}}>3.</span> {`{"command":"firmware_end"}`}</div>
                    </div>
                  </div>
                </>}

              </div>
            </aside>

            {/* Resize handle */}
            <div onMouseDown={startSidebarDrag}
              className="w-1 shrink-0 cursor-ew-resize hover:opacity-60 transition-opacity"
              style={{background:'transparent'}}
              onMouseEnter={e=>(e.currentTarget.style.background=T.accent+'44')}
              onMouseLeave={e=>(e.currentTarget.style.background='transparent')}/>
          </div>
        )}

        {/* ── 3D Viewer ── */}
        <main className="flex-1 relative overflow-hidden">
          <Viewer3D depthBuffer={depthSnap} motors={motors} connected={connected} displayMode={displayMode} theme={activeTheme}/>

          {connected && (
            <div className="absolute bottom-0 inset-x-0 px-5 py-2 flex items-center gap-4 pointer-events-none"
              style={{background:'linear-gradient(to top, rgba(8,12,16,0.8) 0%, transparent 100%)'}}>
              <div className="flex gap-4 font-mono text-[11px]" style={{color:T.muted}}>
                <span>CPU <span style={{color:T.accent}}>{diag.cpu.toFixed(1)}%</span></span>
                <span>BAT <span style={{color:diag.battery>50?'#00cc66':diag.battery>20?'#ffaa00':'#ff4444'}}>{diag.battery.toFixed(0)}%</span></span>
                <span>FPS <span style={{color:T.accent}}>{diag.refresh_rate.toFixed(1)}</span></span>
                {diag.bottleneck!=='none'&&diag.bottleneck!=='' && <span className="animate-pulse" style={{color:'#ff4444'}}>⚠ {diag.bottleneck.toUpperCase()}</span>}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
