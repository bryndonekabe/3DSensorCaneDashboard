export interface DepthUpdate {
  i: number  // 0–63, row-major into 8×8 grid
  d: number  // depth in meters
}

export interface MotorState {
  left: number   // 0.0–1.0
  right: number  // 0.0–1.0
}

export interface Diagnostics {
  cpu: number
  battery: number
  refresh_rate: number
  speed: number
  bottleneck: string
  uptime: number
  temp?: number
  signal?: number
}

export interface CaneFrame {
  timestamp: number
  updates: DepthUpdate[]
  motors: MotorState
  diagnostics: Diagnostics
}

export interface CaneSettings {
  motor_left_mult: number
  motor_right_mult: number
  refresh_rate: number
  threshold_near: number
  threshold_far: number
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type Protocol = 'websocket' | 'mqtt'
export type DisplayMode = 'dots' | 'spheres' | 'mesh'

export const SENSOR_ROWS = 8
export const SENSOR_COLS = 16
// export const SENSOR_COLS = 8
export const FOV_H_DEG = 120
// export const FOV_H_DEG = 60
export const FOV_V_DEG = 60
export const MAX_RANGE = 3.5
export const GRID_SIZE = SENSOR_ROWS * SENSOR_COLS
