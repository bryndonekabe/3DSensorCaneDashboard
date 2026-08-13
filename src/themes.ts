export interface Theme {
  id: string
  name: string
  // Three.js scene (numeric hex)
  bgColor: number
  gridColor: number
  nearColor: number
  midColor: number
  farColor: number
  // Motor indicator hues (degrees)
  motorLeftHue: number
  motorRightHue: number
  // CSS colors for UI
  accent: string
  accentDim: string
  surfaceBg: string
  panelBg: string
  panelBg2: string
  border: string
  text: string
  muted: string
}

export const THEMES: Theme[] = [
  {
    id: 'void',
    name: 'Void',
    bgColor: 0x0e1a28, gridColor: 0x1a3050,
    nearColor: 0xff2222, midColor: 0xffaa00, farColor: 0x00e5ff,
    motorLeftHue: 180, motorRightHue: 195,
    accent: '#00e5ff', accentDim: '#00b8cc',
    surfaceBg: '#080c10', panelBg: '#0d1520', panelBg2: '#111d2e',
    border: '#1a2d42',
    text: '#e6f2ff',
    muted: '#8fa8c2',
  },

  {
    id: 'ember',
    name: 'Ember',
    bgColor: 0x1c1008, gridColor: 0x3d1e0a,
    nearColor: 0xff1111, midColor: 0xff6600, farColor: 0xffcc00,
    motorLeftHue: 30, motorRightHue: 45,
    accent: '#ff7700', accentDim: '#cc5500',
    surfaceBg: '#0e0804', panelBg: '#1a0d06', panelBg2: '#22110a',
    border: '#3d1e0a',
    text: '#ffe8d0',
    muted: '#b08060',
  },

  {
    id: 'matrix',
    name: 'Matrix',
    bgColor: 0x071a0c, gridColor: 0x0c2e12,
    nearColor: 0x00ff44, midColor: 0x00dd88, farColor: 0x00aacc,
    motorLeftHue: 140, motorRightHue: 160,
    accent: '#00ff66', accentDim: '#00cc44',
    surfaceBg: '#020e04', panelBg: '#061408', panelBg2: '#0a1e0d',
    border: '#0e3316',
    text: '#d8ffe0',
    muted: '#76b88a',
  },

  {
    id: 'plasma',
    name: 'Plasma',
    bgColor: 0x140a28, gridColor: 0x250f48,
    nearColor: 0xff00aa, midColor: 0xaa00ff, farColor: 0x00ccff,
    motorLeftHue: 280, motorRightHue: 300,
    accent: '#cc44ff', accentDim: '#9922cc',
    surfaceBg: '#0a0514', panelBg: '#12082a', panelBg2: '#180e36',
    border: '#2e1255',
    text: '#f0dcff',
    muted: '#a078c0',
  },

  {
    id: 'frost',
    name: 'Frost',
    bgColor: 0x0c1e30, gridColor: 0x173048,
    nearColor: 0xffffff, midColor: 0x88ccff, farColor: 0x0088ee,
    motorLeftHue: 210, motorRightHue: 220,
    accent: '#66aaff', accentDim: '#4488cc',
    surfaceBg: '#06101a', panelBg: '#0d1a28', panelBg2: '#122030',
    border: '#1a3050',
    text: '#e0efff',
    muted: '#82a6c4',
  },
]

export const DEFAULT_THEME = THEMES[0]
