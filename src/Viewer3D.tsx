import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MotorState } from './types'
import { SENSOR_ROWS, SENSOR_COLS, FOV_H_DEG, FOV_V_DEG, MAX_RANGE, GRID_SIZE } from './types'

interface Props {
  depthBuffer: Float32Array
  motors: MotorState
  connected: boolean
}

const FOV_H = (FOV_H_DEG * Math.PI) / 180
const FOV_V = (FOV_V_DEG * Math.PI) / 180

// Pre-computed unit ray directions for each grid cell
const RAY_DIRS: THREE.Vector3[] = []
for (let row = 0; row < SENSOR_ROWS; row++) {
  for (let col = 0; col < SENSOR_COLS; col++) {
    const az = ((col / (SENSOR_COLS - 1)) - 0.5) * FOV_H
    const el = ((row / (SENSOR_ROWS - 1)) - 0.5) * FOV_V
    RAY_DIRS.push(new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      -Math.sin(el),
      Math.cos(az) * Math.cos(el),
    ).normalize())
  }
}

const _color = new THREE.Color()
function depthColor(d: number): THREE.Color {
  const t = Math.min(d / MAX_RANGE, 1)
  if (t < 0.5) return _color.lerpColors(new THREE.Color(0xff2222), new THREE.Color(0xffaa00), t * 2)
  return _color.lerpColors(new THREE.Color(0xffaa00), new THREE.Color(0x00e5ff), (t - 0.5) * 2)
}

export default function Viewer3D({ depthBuffer, motors, connected }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    instanceMesh: THREE.InstancedMesh
    dummy: THREE.Object3D
    raf: number
  } | null>(null)

  const init = useCallback(() => {
    const el = containerRef.current
    if (!el || sceneRef.current) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x080c10)
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x080c10, 0.065)

    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.05, 30)
    camera.position.set(0, 2.5, -4.5)
    camera.lookAt(0, 0.5, 2)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.5, 2)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.minDistance = 0.3
    controls.maxDistance = 15
    controls.update()

    // Floor grid
    scene.add(new THREE.GridHelper(16, 32, 0x0b1e30, 0x0b1e30))

    // Sensor origin octahedron
    const originMesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.055, 0),
      new THREE.MeshBasicMaterial({ color: 0x00ffaa })
    )
    scene.add(originMesh)

    // FOV cone
    const coneGeo = new THREE.ConeGeometry(Math.tan(FOV_H / 2) * MAX_RANGE * 0.9, MAX_RANGE, 8, 1, true)
    const coneMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, wireframe: true, opacity: 0.05, transparent: true })
    const cone = new THREE.Mesh(coneGeo, coneMat)
    cone.rotation.x = -Math.PI / 2
    cone.position.z = MAX_RANGE / 2
    scene.add(cone)

    // Range arcs
    const arcColors = [0xff3333, 0xffaa00, 0x00e5ff]
    for (let r = 1; r <= Math.floor(MAX_RANGE); r++) {
      const pts: THREE.Vector3[] = []
      for (let a = -FOV_H / 2; a <= FOV_H / 2; a += 0.04) {
        pts.push(new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r))
      }
      scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: arcColors[r - 1] ?? 0x00e5ff, opacity: 0.22, transparent: true })
      ))
    }

    // Instanced spheres — one per grid cell
    const sphereGeo = new THREE.SphereGeometry(0.048, 7, 5)
    const sphereMat = new THREE.MeshBasicMaterial()
    const instanceMesh = new THREE.InstancedMesh(sphereGeo, sphereMat, GRID_SIZE)
    instanceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    instanceMesh.count = 0
    scene.add(instanceMesh)

    const dummy = new THREE.Object3D()

    const onResize = () => {
      if (!el) return
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(el.clientWidth, el.clientHeight)
    }
    window.addEventListener('resize', onResize)

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    sceneRef.current = { renderer, scene, camera, controls, instanceMesh, dummy, raf }
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

  // Update instanced mesh from depth buffer
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    const { instanceMesh, dummy } = s

    let count = 0
    for (let i = 0; i < depthBuffer.length; i++) {
      const d = depthBuffer[i]
      if (isNaN(d) || d <= 0 || d > MAX_RANGE) continue
      const ray = RAY_DIRS[i]
      dummy.position.set(ray.x * d, ray.y * d, ray.z * d)
      dummy.updateMatrix()
      instanceMesh.setMatrixAt(count, dummy.matrix)
      instanceMesh.setColorAt(count, depthColor(d).clone())
      count++
    }
    instanceMesh.count = count
    instanceMesh.instanceMatrix.needsUpdate = true
    if (instanceMesh.instanceColor) instanceMesh.instanceColor.needsUpdate = true
  }, [depthBuffer])

  const motorGlow = (v: number, hue: number) => ({
    border: `1px solid hsl(${hue}deg 100% ${25 + v * 45}%)`,
    background: `hsla(${hue}, 100%, 8%, ${0.2 + v * 0.5})`,
    boxShadow: v > 0.05 ? `0 0 ${6 + v * 18}px hsla(${hue}deg, 100%, 60%, ${v * 0.65})` : 'none',
  })

  return (
    <div className="relative w-full h-full select-none">
      <div ref={containerRef} className="w-full h-full" />

      {/* ── Motor indicators ── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-stretch gap-0 pointer-events-none rounded overflow-hidden border border-[#1a2d42]">
        {/* Left */}
        <div className="flex flex-col items-center gap-1 px-5 py-2.5 transition-all duration-75 min-w-[90px]"
          style={motorGlow(motors.left, 180)}>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Left</span>
            {motors.left > 0.04 && <span className="w-1.5 h-1.5 rounded-full bg-[#00e5ff] animate-pulse shrink-0" />}
          </div>
          <span className="font-mono text-xl leading-none tabular-nums"
            style={{ color: `hsl(180deg 100% ${28 + motors.left * 42}%)` }}>
            {Math.round(motors.left * 100)}<span className="text-[11px] text-slate-500 ml-0.5">%</span>
          </span>
          <div className="w-14 h-0.5 rounded-full bg-[#0d2035] overflow-hidden">
            <div className="h-full rounded-full bg-[#00e5ff] transition-all duration-75"
              style={{ width: `${motors.left * 100}%`, opacity: 0.65 + motors.left * 0.35 }} />
          </div>
        </div>

        <div className="w-px bg-[#1a2d42]" />

        {/* Right */}
        <div className="flex flex-col items-center gap-1 px-5 py-2.5 transition-all duration-75 min-w-[90px]"
          style={motorGlow(motors.right, 195)}>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Right</span>
            {motors.right > 0.04 && <span className="w-1.5 h-1.5 rounded-full bg-[#00c8e5] animate-pulse shrink-0" />}
          </div>
          <span className="font-mono text-xl leading-none tabular-nums"
            style={{ color: `hsl(195deg 100% ${28 + motors.right * 42}%)` }}>
            {Math.round(motors.right * 100)}<span className="text-[11px] text-slate-500 ml-0.5">%</span>
          </span>
          <div className="w-14 h-0.5 rounded-full bg-[#0d2035] overflow-hidden">
            <div className="h-full rounded-full bg-[#00c8e5] transition-all duration-75"
              style={{ width: `${motors.right * 100}%`, opacity: 0.65 + motors.right * 0.35 }} />
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-1.5 pointer-events-none">
        <div className="flex items-center gap-2">
          <span className="inline-block w-10 h-0.5 rounded"
            style={{ background: 'linear-gradient(to right,#ff2222,#ffaa00,#00e5ff)' }} />
          <span className="text-[9px] font-mono text-slate-600">0 — {MAX_RANGE}m</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[#00ffaa] shrink-0" />
          <span className="text-[9px] font-mono text-slate-600">Sensor origin</span>
        </div>
      </div>

      {/* Controls hint */}
      <div className="absolute top-4 right-4 text-[9px] font-mono text-slate-700 text-right leading-relaxed pointer-events-none">
        <div>Drag · Rotate</div>
        <div>Scroll · Zoom</div>
        <div>Right drag · Pan</div>
      </div>

      {/* No signal */}
      {!connected && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 opacity-25">
            <div className="text-3xl font-mono text-[#00e5ff] tracking-[0.3em]">NO SIGNAL</div>
            <div className="text-xs text-slate-400">Awaiting cane connection</div>
          </div>
        </div>
      )}
    </div>
  )
}
