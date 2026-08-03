import { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MotorState, DisplayMode } from './types'
import { SENSOR_ROWS, SENSOR_COLS, FOV_H_DEG, FOV_V_DEG, MAX_RANGE, GRID_SIZE } from './types'
import type { Theme } from './themes'

interface Props {
  depthBuffer: Float32Array
  motors: MotorState
  connected: boolean
  displayMode: DisplayMode
  theme: Theme
}

// ─── Sensor geometry ──────────────────────────────────────────────────────────
const FOV_H = (FOV_H_DEG * Math.PI) / 180
const FOV_V = (FOV_V_DEG * Math.PI) / 180

const RAY_DIRS: THREE.Vector3[] = []
for (let row = 0; row < SENSOR_ROWS; row++) {
  for (let col = 0; col < SENSOR_COLS; col++) {
    const az = ((col / (SENSOR_COLS - 1)) - 0.5) * FOV_H
    const el = ((row / (SENSOR_ROWS - 1)) - 0.5) * FOV_V
    RAY_DIRS.push(
      new THREE.Vector3(Math.sin(az) * Math.cos(el), -Math.sin(el), Math.cos(az) * Math.cos(el)).normalize()
    )
  }
}

function makeDepthColor(d: number, near: THREE.Color, mid: THREE.Color, far: THREE.Color): THREE.Color {
  const t = Math.min(d / MAX_RANGE, 1)
  const out = new THREE.Color()
  return t < 0.5 ? out.lerpColors(near, mid, t * 2) : out.lerpColors(mid, far, (t - 0.5) * 2)
}

// Fill NaN / out-of-range cells by iteratively averaging valid neighbours,
// then falling back to MAX_RANGE so the mesh always covers the full 8×8 grid.
function fillDepthBuffer(buf: Float32Array): Float32Array {
  const out = new Float32Array(buf)
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < GRID_SIZE; i++) {
      if (!isNaN(out[i]) && out[i] > 0 && out[i] <= MAX_RANGE) continue
      const row = Math.floor(i / SENSOR_COLS), col = i % SENSOR_COLS
      const ns: number[] = []
      if (row > 0 && !isNaN(out[i - SENSOR_COLS]) && out[i - SENSOR_COLS] > 0) ns.push(out[i - SENSOR_COLS])
      if (row < SENSOR_ROWS - 1 && !isNaN(out[i + SENSOR_COLS]) && out[i + SENSOR_COLS] > 0) ns.push(out[i + SENSOR_COLS])
      if (col > 0 && !isNaN(out[i - 1]) && out[i - 1] > 0) ns.push(out[i - 1])
      if (col < SENSOR_COLS - 1 && !isNaN(out[i + 1]) && out[i + 1] > 0) ns.push(out[i + 1])
      if (ns.length > 0) { out[i] = ns.reduce((a, b) => a + b, 0) / ns.length; changed = true }
    }
  }
  for (let i = 0; i < GRID_SIZE; i++) if (isNaN(out[i]) || out[i] <= 0) out[i] = MAX_RANGE
  return out
}

function buildMeshGeometry(buf: Float32Array, near: THREE.Color, mid: THREE.Color, far: THREE.Color): THREE.BufferGeometry {
  const filled = fillDepthBuffer(buf)
  const positions: number[] = [], colors: number[] = [], indices: number[] = []

  for (let i = 0; i < GRID_SIZE; i++) {
    const d = filled[i]
    const r = RAY_DIRS[i]
    positions.push(r.x * d, r.y * d, r.z * d)
    const c = makeDepthColor(d, near, mid, far)
    colors.push(c.r, c.g, c.b)
  }

  // Every adjacent quad → 2 triangles, no discontinuity skip (hole-free)
  for (let row = 0; row < SENSOR_ROWS - 1; row++) {
    for (let col = 0; col < SENSOR_COLS - 1; col++) {
      const i00 = row * SENSOR_COLS + col, i01 = i00 + 1
      const i10 = i00 + SENSOR_COLS, i11 = i10 + 1
      indices.push(i00, i01, i10)
      indices.push(i01, i11, i10)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

// ─── Draggable / resizable motor box ─────────────────────────────────────────
interface MotorBoxProps { motors: MotorState; theme: Theme; boundsRef: React.RefObject<HTMLDivElement | null> }
interface BoxState { x: number; y: number; w: number }

function MotorBox({ motors, theme, boundsRef }: MotorBoxProps) {
  const [box, setBox] = useState<BoxState>({ x: 0, y: 16, w: 220 })
  const [ready, setReady] = useState(false)
  const dragRef = useRef<{ type: 'move' | 'resize'; sx: number; sy: number; orig: BoxState } | null>(null)

  useLayoutEffect(() => {
    const el = boundsRef.current
    if (!el || ready) return
    setBox(b => ({ ...b, x: Math.round((el.clientWidth - b.w) / 2) }))
    setReady(true)
  }, [boundsRef, ready])

  const startDrag = (e: React.PointerEvent, type: 'move' | 'resize') => {
    e.stopPropagation(); e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { type, sx: e.clientX, sy: e.clientY, orig: { ...box } }
  }

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return
    const el = boundsRef.current
    const cw = el?.clientWidth ?? 800, ch = el?.clientHeight ?? 600
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (d.type === 'move') {
      setBox({ ...d.orig, x: Math.max(0, Math.min(cw - d.orig.w, d.orig.x + dx)), y: Math.max(0, Math.min(ch - 90, d.orig.y + dy)) })
    } else {
      setBox(b => ({ ...b, w: Math.max(160, Math.min(380, d.orig.w + dx)) }))
    }
  }

  const onUp = () => { dragRef.current = null }

  const motorCell = (side: 'left' | 'right') => {
    const v = motors[side]
    const hue = side === 'left' ? theme.motorLeftHue : theme.motorRightHue
    const fs = Math.max(14, Math.round(box.w * 0.082))
    return (
      <div key={side} className="flex-1 flex flex-col items-center gap-1 transition-all duration-75"
        style={{
          minWidth: 0, padding: '8px 6px',
          background: `hsla(${hue}deg, 90%, 8%, ${0.25 + v * 0.5})`,
          boxShadow: v > 0.04 ? `0 0 ${6 + v * 20}px hsla(${hue}deg, 100%, 55%, ${v * 0.55})` : 'none',
        }}>
        <div className="flex items-center gap-1.5 justify-center">
          <span className="font-mono uppercase tracking-widest" style={{ fontSize: 9, color: theme.muted }}>
            {side}
          </span>
          {v > 0.04 && <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
            style={{ background: `hsl(${hue}deg 100% 60%)` }} />}
        </div>
        <span className="font-mono tabular-nums leading-none" style={{ fontSize: fs, color: `hsl(${hue}deg 100% ${28 + v * 42}%)` }}>
          {Math.round(v * 100)}<span style={{ fontSize: Math.max(9, fs * 0.6), color: theme.muted }}>%</span>
        </span>
        <div className="rounded-full overflow-hidden" style={{ width: '75%', height: 2, background: theme.panelBg2 }}>
          <div className="h-full rounded-full transition-all duration-75"
            style={{ width: `${v * 100}%`, background: `hsl(${hue}deg 100% 55%)` }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, userSelect: 'none', zIndex: 20 }}
      onPointerMove={onMove} onPointerUp={onUp}>
      {/* Drag handle */}
      <div onPointerDown={e => startDrag(e, 'move')}
        className="flex items-center justify-center cursor-grab active:cursor-grabbing"
        style={{ height: 18, background: theme.panelBg2, borderTop: `1px solid ${theme.border}`, borderLeft: `1px solid ${theme.border}`, borderRight: `1px solid ${theme.border}`, borderRadius: '4px 4px 0 0' }}>
        <div className="flex gap-0.5">
          {[0,1,2,3,4,5].map(i => <div key={i} className="rounded-full" style={{ width: 14, height: 2, background: theme.border }}/>)}
        </div>
      </div>

      {/* Motor cells */}
      <div className="flex" style={{ borderBottom: `1px solid ${theme.border}`, borderLeft: `1px solid ${theme.border}`, borderRight: `1px solid ${theme.border}`, borderRadius: '0 0 4px 4px', overflow: 'hidden' }}>
        {motorCell('left')}
        <div style={{ width: 1, background: theme.border, flexShrink: 0 }}/>
        {motorCell('right')}
      </div>

      {/* Resize grip */}
      <div onPointerDown={e => startDrag(e, 'resize')}
        className="absolute bottom-0 right-0 cursor-ew-resize flex items-end justify-end"
        style={{ width: 16, height: 16, zIndex: 21, padding: '2px 2px' }}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M7 1L1 7M7 4L4 7" stroke={theme.muted} strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </div>
    </div>
  )
}

// ─── Main Viewer ──────────────────────────────────────────────────────────────
export default function Viewer3D({ depthBuffer, motors, connected, displayMode, theme }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)   // outer div — bounds for MotorBox
  const canvasRef = useRef<HTMLDivElement>(null)  // inner div — renderer target

  const nearC = useRef(new THREE.Color(theme.nearColor))
  const midC = useRef(new THREE.Color(theme.midColor))
  const farC = useRef(new THREE.Color(theme.farColor))
  const keysRef = useRef(new Set<string>())

  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    ptCloud: THREE.Points
    instMesh: THREE.InstancedMesh
    surfMesh: THREE.Mesh
    dummy: THREE.Object3D
    raf: number
  } | null>(null)

  // Keyboard camera movement
  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return
      keysRef.current.add(e.key.toLowerCase())
    }
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase())
    window.addEventListener('keydown', dn)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up) }
  }, [])

  const init = useCallback(() => {
    const el = canvasRef.current
    if (!el || sceneRef.current) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(theme.bgColor)
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(theme.bgColor, 0.055)

    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.05, 30)
    camera.position.set(0, 2.5, -4.5)
    camera.lookAt(0, 0.5, 2)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.5, 2)
    controls.enableDamping = true; controls.dampingFactor = 0.07
    controls.minDistance = 0.3; controls.maxDistance = 18
    controls.update()

    // Grid
    scene.add(new THREE.GridHelper(18, 36, theme.gridColor, theme.gridColor))

    // Origin marker
    scene.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), new THREE.MeshBasicMaterial({ color: theme.farColor })))

    // FOV cone
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(Math.tan(FOV_H / 2) * MAX_RANGE * 0.9, MAX_RANGE, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: theme.farColor, wireframe: true, opacity: 0.05, transparent: true })
    )
    cone.rotation.x = -Math.PI / 2; cone.position.z = MAX_RANGE / 2
    scene.add(cone)

    // Range arcs
    const arcCols = [theme.nearColor, theme.midColor, theme.farColor]
    for (let r = 1; r <= Math.floor(MAX_RANGE); r++) {
      const pts: THREE.Vector3[] = []
      for (let a = -FOV_H / 2; a <= FOV_H / 2; a += 0.04)
        pts.push(new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r))
      scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: arcCols[r - 1] ?? theme.farColor, opacity: 0.2, transparent: true })
      ))
    }

    // Dots
    const ptCloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.06, vertexColors: true, sizeAttenuation: true }))
    scene.add(ptCloud)

    // Spheres
    const instMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.048, 7, 5), new THREE.MeshBasicMaterial(), GRID_SIZE)
    instMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); instMesh.count = 0
    scene.add(instMesh)

    // Mesh surface
    const surfMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
    scene.add(surfMesh)

    const dummy = new THREE.Object3D()

    const onResize = () => {
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(el.clientWidth, el.clientHeight)
    }
    window.addEventListener('resize', onResize)

    const camDir = new THREE.Vector3(), camRight = new THREE.Vector3(), mv = new THREE.Vector3()
    const SPEED = 0.05

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const keys = keysRef.current
      if (keys.size > 0) {
        camera.getWorldDirection(camDir); camDir.y = 0
        if (camDir.lengthSq() > 0.0001) camDir.normalize()
        camRight.crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize()
        mv.set(0, 0, 0)
        if (keys.has('w') || keys.has('arrowup')) mv.addScaledVector(camDir, SPEED)
        if (keys.has('s') || keys.has('arrowdown')) mv.addScaledVector(camDir, -SPEED)
        if (keys.has('a') || keys.has('arrowleft')) mv.addScaledVector(camRight, -SPEED)
        if (keys.has('d') || keys.has('arrowright')) mv.addScaledVector(camRight, SPEED)
        if (keys.has('e')) mv.y += SPEED
        if (keys.has('q')) mv.y -= SPEED
        if (mv.lengthSq() > 0) { camera.position.add(mv); controls.target.add(mv) }
      }
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    sceneRef.current = { renderer, scene, camera, controls, ptCloud, instMesh, surfMesh, dummy, raf }
    return () => window.removeEventListener('resize', onResize)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cleanup = init()
    return () => {
      cleanup?.()
      if (sceneRef.current) {
        cancelAnimationFrame(sceneRef.current.raf)
        sceneRef.current.renderer.dispose()
        sceneRef.current.renderer.domElement.remove()
        sceneRef.current = null
      }
    }
  }, [init])

  // Sync theme colors to live refs + renderer
  useEffect(() => {
    nearC.current.set(theme.nearColor)
    midC.current.set(theme.midColor)
    farC.current.set(theme.farColor)
    const s = sceneRef.current; if (!s) return
    s.renderer.setClearColor(theme.bgColor)
    ;(s.scene.fog as THREE.FogExp2).color.set(theme.bgColor)
  }, [theme])

  // Rebuild point cloud / spheres / mesh
  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    const near = nearC.current, mid = midC.current, far = farC.current

    s.ptCloud.visible = displayMode === 'dots'
    s.instMesh.visible = displayMode === 'spheres'
    s.surfMesh.visible = displayMode === 'mesh'

    if (displayMode === 'dots') {
      const valid: { p: THREE.Vector3; d: number }[] = []
      for (let i = 0; i < depthBuffer.length; i++) {
        const d = depthBuffer[i]; if (isNaN(d)||d<=0||d>MAX_RANGE) continue
        valid.push({ p: RAY_DIRS[i].clone().multiplyScalar(d), d })
      }
      const pos = new Float32Array(valid.length*3), col = new Float32Array(valid.length*3)
      valid.forEach(({p,d},i) => {
        pos[i*3]=p.x;pos[i*3+1]=p.y;pos[i*3+2]=p.z
        const c=makeDepthColor(d,near,mid,far); col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b
      })
      s.ptCloud.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      s.ptCloud.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))

    } else if (displayMode === 'spheres') {
      let count = 0
      for (let i = 0; i < depthBuffer.length; i++) {
        const d = depthBuffer[i]; if (isNaN(d)||d<=0||d>MAX_RANGE) continue
        const r = RAY_DIRS[i]
        s.dummy.position.set(r.x*d, r.y*d, r.z*d); s.dummy.updateMatrix()
        s.instMesh.setMatrixAt(count, s.dummy.matrix)
        s.instMesh.setColorAt(count, makeDepthColor(d, near, mid, far).clone())
        count++
      }
      s.instMesh.count = count
      s.instMesh.instanceMatrix.needsUpdate = true
      if (s.instMesh.instanceColor) s.instMesh.instanceColor.needsUpdate = true

    } else {
      const old = s.surfMesh.geometry
      s.surfMesh.geometry = buildMeshGeometry(depthBuffer, near, mid, far)
      old.dispose()
    }
  }, [depthBuffer, displayMode, theme])

  const hexCss = (n: number) => `#${n.toString(16).padStart(6,'0')}`

  return (
    <div ref={wrapRef} className="relative w-full h-full select-none overflow-hidden">
      <div ref={canvasRef} className="w-full h-full" />

      <MotorBox motors={motors} theme={theme} boundsRef={wrapRef as React.RefObject<HTMLDivElement | null>} />

      {/* Legend */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-1.5 pointer-events-none">
        <div className="flex items-center gap-2">
          <span className="inline-block w-10 h-0.5 rounded" style={{
            background: `linear-gradient(to right, ${hexCss(theme.nearColor)}, ${hexCss(theme.midColor)}, ${hexCss(theme.farColor)})`
          }}/>
          <span className="text-[9px] font-mono" style={{ color: theme.muted }}>0 — {MAX_RANGE}m</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: theme.accent }}/>
          <span className="text-[9px] font-mono" style={{ color: theme.muted }}>Sensor origin</span>
        </div>
      </div>

      {/* Controls hint */}
      <div className="absolute top-4 right-4 text-[9px] font-mono text-right leading-relaxed pointer-events-none">
        <div style={{ color: theme.muted }}>Drag · Orbit &nbsp; Scroll · Zoom</div>
        <div style={{ color: theme.muted }}>Right drag · Pan</div>
        <div className="mt-1" style={{ color: theme.accent, opacity: 0.7 }}>W A S D · Move &nbsp; Q E · Up/Down</div>
      </div>

      {!connected && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2" style={{ opacity: 0.22 }}>
            <div className="text-3xl font-mono tracking-[0.3em]" style={{ color: theme.accent }}>NO SIGNAL</div>
            <div className="text-xs font-mono" style={{ color: theme.muted }}>Awaiting connection</div>
          </div>
        </div>
      )}
    </div>
  )
}
