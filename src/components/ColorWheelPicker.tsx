import { useRef, useState, useCallback, useEffect } from 'react'

// --- Color conversion utilities ---
function hsvToRgb(h: number, s: number, v: number) {
  s /= 100; v /= 100
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c }
  else { r = c; b = x }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  const s = max === 0 ? 0 : d / max
  const v = max
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h: Math.round(h), s: Math.round(s * 100), v: Math.round(v * 100) }
}

function rgbToHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

function hexToRgb(hex: string) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 }
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function hslToRgb(h: number, s: number, l: number) {
  s /= 100; l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c }
  else { r = c; b = x }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

// --- Preset common colors (circular swatches) ---
const COMMON_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff',
  '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3',
  '#c9daf8', '#d9d2e9', '#f1c232', '#e06666', '#6aa84f', '#45818e', '#3c78d8', '#674ea7',
]

type ColorMode = 'RGB' | 'HSL' | 'HEX'

interface ColorWheelPickerProps {
  color: string // hex
  onChange: (hex: string) => void
}

export function ColorWheelPicker({ color, onChange }: ColorWheelPickerProps) {
  const [mode, setMode] = useState<ColorMode>('RGB')
  const wheelRef = useRef<HTMLCanvasElement>(null)
  const squareRef = useRef<HTMLCanvasElement>(null)
  const isDraggingWheel = useRef(false)
  const isDraggingSquare = useRef(false)

  const rgb = hexToRgb(color)
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
  const currentHex = rgbToHex(rgb.r, rgb.g, rgb.b).toUpperCase()

  // Draw hue wheel
  const drawWheel = useCallback(() => {
    const canvas = wheelRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const size = canvas.width
    const cx = size / 2, cy = size / 2
    const outerR = size / 2 - 4
    const innerR = outerR - 22

    ctx.clearRect(0, 0, size, size)

    // Draw hue ring
    for (let angle = 0; angle < 360; angle += 0.5) {
      const rad1 = (angle - 0.5) * Math.PI / 180
      const rad2 = (angle + 0.5) * Math.PI / 180
      ctx.beginPath()
      ctx.arc(cx, cy, outerR, rad1, rad2)
      ctx.arc(cx, cy, innerR, rad2, rad1, true)
      ctx.closePath()
      const c = hsvToRgb(angle, 100, 100)
      ctx.fillStyle = rgbToHex(c.r, c.g, c.b)
      ctx.fill()
    }

    // Draw hue indicator
    const hueRad = hsv.h * Math.PI / 180
    const midR = (outerR + innerR) / 2
    const ix = cx + Math.cos(hueRad) * midR
    const iy = cy + Math.sin(hueRad) * midR
    ctx.beginPath()
    ctx.arc(ix, iy, 8, 0, Math.PI * 2)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(ix, iy, 7, 0, Math.PI * 2)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1
    ctx.stroke()
  }, [hsv.h])

  // Draw SV square inside wheel — smaller, leaves gap from ring
  const drawSquare = useCallback(() => {
    const canvas = squareRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width, h = canvas.height

    // Background: hue at full saturation/value
    const baseRgb = hsvToRgb(hsv.h, 100, 100)
    ctx.fillStyle = rgbToHex(baseRgb.r, baseRgb.g, baseRgb.b)
    ctx.fillRect(0, 0, w, h)

    // White gradient left-to-right
    const whiteGrad = ctx.createLinearGradient(0, 0, w, 0)
    whiteGrad.addColorStop(0, '#ffffff')
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = whiteGrad
    ctx.fillRect(0, 0, w, h)

    // Black gradient top-to-bottom
    const blackGrad = ctx.createLinearGradient(0, 0, 0, h)
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)')
    blackGrad.addColorStop(1, '#000000')
    ctx.fillStyle = blackGrad
    ctx.fillRect(0, 0, w, h)

    // Draw crosshair indicator
    const px = (hsv.s / 100) * w
    const py = (1 - hsv.v / 100) * h
    ctx.beginPath()
    ctx.arc(px, py, 6, 0, Math.PI * 2)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(px, py, 5, 0, Math.PI * 2)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1
    ctx.stroke()
  }, [hsv.h, hsv.s, hsv.v])

  useEffect(() => { drawWheel() }, [drawWheel])
  useEffect(() => { drawSquare() }, [drawSquare])

  // Handle wheel mouse events
  const handleWheelInteraction = useCallback((e: React.MouseEvent<HTMLCanvasElement> | MouseEvent) => {
    const canvas = wheelRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) * (canvas.width / rect.width)
    const y = (e.clientY - rect.top) * (canvas.height / rect.height)
    const cx = canvas.width / 2, cy = canvas.height / 2
    let angle = Math.atan2(y - cy, x - cx) * 180 / Math.PI
    if (angle < 0) angle += 360
    const newRgb = hsvToRgb(Math.round(angle), hsv.s, hsv.v)
    onChange(rgbToHex(newRgb.r, newRgb.g, newRgb.b))
  }, [hsv.s, hsv.v, onChange])

  // Handle square mouse events
  const handleSquareInteraction = useCallback((e: React.MouseEvent<HTMLCanvasElement> | MouseEvent) => {
    const canvas = squareRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    const newS = Math.round(x * 100)
    const newV = Math.round((1 - y) * 100)
    const newRgb = hsvToRgb(hsv.h, newS, newV)
    onChange(rgbToHex(newRgb.r, newRgb.g, newRgb.b))
  }, [hsv.h, onChange])

  // Global mouse move/up handlers for dragging
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isDraggingWheel.current) handleWheelInteraction(e)
      if (isDraggingSquare.current) handleSquareInteraction(e)
    }
    const onUp = () => {
      isDraggingWheel.current = false
      isDraggingSquare.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [handleWheelInteraction, handleSquareInteraction])

  const handleSliderChange = (channel: string, value: number) => {
    let newRgb = { ...rgb }
    if (mode === 'RGB') {
      (newRgb as any)[channel] = value
    } else if (mode === 'HSL') {
      const newHsl = { ...hsl }
      ;(newHsl as any)[channel] = value
      newRgb = hslToRgb(newHsl.h, newHsl.s, newHsl.l)
    }
    onChange(rgbToHex(newRgb.r, newRgb.g, newRgb.b))
  }

  const handleHexInput = (hex: string) => {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '')
    if (clean.length === 6) {
      onChange('#' + clean)
    }
  }

  // Build slider definitions with real CSS colors for the track
  const sliders = mode === 'RGB' ? [
    { label: 'R', value: rgb.r, min: 0, max: 255, channel: 'r', trackColor: '#ef4444', trackBg: '#3a1111' },
    { label: 'G', value: rgb.g, min: 0, max: 255, channel: 'g', trackColor: '#22c55e', trackBg: '#113a1a' },
    { label: 'B', value: rgb.b, min: 0, max: 255, channel: 'b', trackColor: '#3b82f6', trackBg: '#111a3a' },
  ] : mode === 'HSL' ? [
    { label: 'H', value: hsl.h, min: 0, max: 360, channel: 'h', trackColor: '#f97316', trackBg: '#3a2211' },
    { label: 'S', value: hsl.s, min: 0, max: 100, channel: 's', trackColor: '#a855f7', trackBg: '#2a113a' },
    { label: 'L', value: hsl.l, min: 0, max: 100, channel: 'l', trackColor: '#eab308', trackBg: '#3a3511' },
  ] : []

  return (
    <div className="w-72 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-700 p-4">
      {/* Title */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">颜色筛选</span>
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-5 rounded-full border border-zinc-300 dark:border-zinc-600 shadow-sm" style={{ backgroundColor: color }} />
          <span className="text-[10px] text-zinc-500 font-mono">{currentHex}</span>
        </div>
      </div>

      {/* Hue Wheel + SV Square */}
      <div className="relative w-full aspect-square mb-3">
        <canvas
          ref={wheelRef}
          width={288}
          height={288}
          className="w-full h-full cursor-crosshair"
          onMouseDown={(e) => { isDraggingWheel.current = true; handleWheelInteraction(e) }}
        />
        <canvas
          ref={squareRef}
          width={160}
          height={160}
          className="absolute cursor-crosshair rounded-sm"
          style={{
            top: '50%', left: '50%',
            width: '50%', height: '50%',
            transform: 'translate(-50%, -50%)',
          }}
          onMouseDown={(e) => { isDraggingSquare.current = true; handleSquareInteraction(e) }}
        />
      </div>

      {/* Common Colors */}
      <div className="mb-3">
        <span className="text-[10px] text-zinc-400 mb-1.5 block">常用颜色</span>
        <div className="flex flex-wrap gap-1">
          {COMMON_COLORS.map((c) => (
            <button
              key={c}
              className="w-5 h-5 rounded-full border border-zinc-200 dark:border-zinc-700 hover:scale-125 transition-transform"
              style={{ backgroundColor: c }}
              onClick={() => onChange(c)}
              title={c}
            />
          ))}
        </div>
      </div>

      {/* Mode Toggle */}
      <div className="flex items-center gap-0.5 mb-2 bg-zinc-100 dark:bg-zinc-800 rounded-md p-0.5">
        {(['RGB', 'HSL', 'HEX'] as ColorMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 text-[10px] py-1 rounded transition-colors font-medium ${
              mode === m
                ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Sliders with visible track */}
      <div className="space-y-2">
        {mode === 'HEX' ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-400 w-4">#</span>
            <input
              type="text"
              value={currentHex.slice(1)}
              onChange={(e) => handleHexInput(e.target.value)}
              className="flex-1 text-xs bg-zinc-100 dark:bg-zinc-800 rounded px-2 py-1 font-mono text-zinc-900 dark:text-zinc-100 border-none outline-none focus:ring-1 focus:ring-indigo-500"
              maxLength={6}
            />
          </div>
        ) : sliders.map((s) => {
          const pct = ((s.value - s.min) / (s.max - s.min)) * 100
          return (
            <div key={s.label} className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-400 w-3 text-right font-mono">{s.label}</span>
              {/* Custom slider track */}
              <div className="flex-1 relative h-2 rounded-full" style={{ backgroundColor: s.trackBg }}>
                <div
                  className="absolute left-0 top-0 h-full rounded-full"
                  style={{ width: `${pct}%`, backgroundColor: s.trackColor, opacity: 0.85 }}
                />
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  value={s.value}
                  onChange={(e) => handleSliderChange(s.channel, Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                {/* Thumb indicator */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white border-2 shadow-sm -ml-1.5 pointer-events-none"
                  style={{ left: `${pct}%`, borderColor: s.trackColor }}
                />
              </div>
              <input
                type="number"
                min={s.min}
                max={s.max}
                value={s.value}
                onChange={(e) => handleSliderChange(s.channel, Number(e.target.value))}
                className="w-10 text-[10px] text-center bg-zinc-100 dark:bg-zinc-800 rounded px-1 py-0.5 font-mono text-zinc-900 dark:text-zinc-100 border-none outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
