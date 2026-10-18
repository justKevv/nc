import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'

const FLUSH_MS = 300
const HIGHLIGHT = 'rgba(255, 214, 0, 0.30)'
const PEN_WIDTH = 2.5
const ERASE_WIDTH = 22

const styleFor = (mode, color) => {
  if (mode === 'erase') return { width: ERASE_WIDTH, color: '#000' }
  if (mode === 'highlight') return { width: ERASE_WIDTH, color: HIGHLIGHT }
  return { width: PEN_WIDTH, color }
}

/**
 * Freehand ink drawn on top of the notebook, synced through the shared Yjs
 * document as a plain `Y.Array('drawings')` of strokes:
 *
 *   { type: 'pen' | 'highlight' | 'erase', color, width, points: [{x, y}, ...] }
 *
 * Points are stored in the notebook's *content* space (scroll offset added),
 * so a stroke stays glued to the cells under it while the view scrolls. The
 * canvas itself is an overlay pinned to the visible box and only takes pointer
 * events while a tool is armed.
 *
 * Erasing is a stroke with `destination-out` compositing, so erasing and drawing
 * compose in the same order for everyone — there is no separate "remove" op to
 * conflict over. A stroke is flushed to the document every FLUSH_MS while it is
 * in progress so other students watch it being drawn, tagged with a `_liveId`
 * that is replaced (not appended) on each flush; the UndoManager ignores those
 * previews so undo removes whole strokes.
 */
export function useInkCanvas(doc, containerRef) {
  const [mode, setMode] = useState('none')
  const [color, setColor] = useState('#EF4444')
  const [visible, setVisible] = useState(true)
  const [strokes, setStrokes] = useState([])

  const canvasRef = useRef(null)
  const ctxRef = useRef(null)
  const drawingsRef = useRef(null)
  const undoRef = useRef(null)
  const drawingRef = useRef(false)
  const pathRef = useRef([])
  const lastRef = useRef(null)
  const flushRef = useRef(null)
  const liveIdRef = useRef(null)

  /* ---- keep a local copy of the shared stroke list ---- */
  useEffect(() => {
    const drawings = doc.getArray('drawings')
    drawingsRef.current = drawings
    // captureTimeout: 0 keeps every finished stroke its own undo step; without
    // it, strokes drawn in quick succession collapse into one.
    undoRef.current = new Y.UndoManager(drawings, { captureTimeout: 0 })

    const refresh = () => setStrokes(drawings.toArray())
    drawings.observe(refresh)
    refresh()

    return () => {
      drawings.unobserve(refresh)
      undoRef.current?.destroy()
      undoRef.current = null
      drawingsRef.current = null
    }
  }, [doc])

  useEffect(
    () => () => {
      if (flushRef.current) clearInterval(flushRef.current)
    },
    [],
  )

  /* ---- painting ---- */
  const redraw = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const container = containerRef.current
    const left = container?.scrollLeft || 0
    const top = container?.scrollTop || 0

    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    if (!visible) return

    const paint = (points, { width, color: stroke, type }) => {
      if (points.length < 2) return
      ctx.globalCompositeOperation = type === 'erase' ? 'destination-out' : 'source-over'
      ctx.strokeStyle = stroke
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(points[0].x - left, points[0].y - top)
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x - left, points[i].y - top)
      ctx.stroke()
    }

    for (const stroke of strokes) paint(stroke.points, stroke)

    // The stroke currently under this user's cursor, so a long in-progress
    // stroke survives the redraws triggered by remote ink arriving.
    if (drawingRef.current && pathRef.current.length >= 2) {
      paint(pathRef.current, { ...styleFor(mode, color), type: mode })
    }

    ctx.globalCompositeOperation = 'source-over'
  }, [strokes, visible, mode, color, containerRef])

  /* ---- size the overlay to the notebook viewport ---- */
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    ctxRef.current = canvas.getContext('2d')
    ctxRef.current.lineCap = 'round'
    ctxRef.current.lineJoin = 'round'

    const resize = () => {
      const { width, height } = container.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      canvas.width = Math.round(width)
      canvas.height = Math.round(height)
      redraw()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(container)
    container.addEventListener('scroll', redraw)
    resize()

    return () => {
      ro.disconnect()
      container.removeEventListener('scroll', redraw)
    }
  }, [redraw, containerRef])

  /* ---- input ---- */
  const pointAt = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0, docX: 0, docY: 0 }
    const container = containerRef.current
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return { x, y, docX: x + (container?.scrollLeft || 0), docY: y + (container?.scrollTop || 0) }
  }

  /**
   * The in-progress preview is written with a custom transaction origin so the
   * UndoManager ignores it. It must be *deleted* under that same origin: if the
   * removal shared a transaction with the final stroke, undo would restore the
   * preview copy and the stroke would never disappear.
   */
  const dropPreview = () => {
    const drawings = drawingsRef.current
    if (!drawings) return
    drawings.doc.transact(() => {
      for (let i = drawings.length - 1; i >= 0; i--) {
        if (drawings.get(i)?._liveId === liveIdRef.current) {
          drawings.delete(i, 1)
          break
        }
      }
    }, 'live-stroke')
  }

  const pushStroke = (stroke) => {
    const drawings = drawingsRef.current
    if (!drawings) return
    drawings.doc.transact(() => drawings.push([stroke]), null)
  }

  const start = (e) => {
    if (mode === 'none') return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drawingRef.current = true
    const { x, y, docX, docY } = pointAt(e)
    pathRef.current = [{ x: docX, y: docY }]
    lastRef.current = { x, y }
    liveIdRef.current = `live_${doc.clientID}_${Date.now()}`

    const ctx = ctxRef.current
    const { width, color: stroke } = styleFor(mode, color)
    ctx.lineWidth = width
    ctx.strokeStyle = stroke
    ctx.globalCompositeOperation = 'source-over'

    flushRef.current = setInterval(() => {
      if (!drawingsRef.current || pathRef.current.length < 2) return
      dropPreview()
      drawingsRef.current.doc.transact(
        () =>
          drawingsRef.current.push([
            { type: mode, ...styleFor(mode, color), points: [...pathRef.current], _liveId: liveIdRef.current },
          ]),
        'live-stroke',
      )
    }, FLUSH_MS)
  }

  const move = (e) => {
    if (!drawingRef.current) return
    e.preventDefault()
    const { x, y, docX, docY } = pointAt(e)
    pathRef.current.push({ x: docX, y: docY })

    const ctx = ctxRef.current
    if (!ctx || !lastRef.current) return
    ctx.beginPath()
    ctx.moveTo(lastRef.current.x, lastRef.current.y)
    ctx.lineTo(x, y)
    ctx.stroke()
    lastRef.current = { x, y }
  }

  const stop = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    clearInterval(flushRef.current)
    flushRef.current = null
    dropPreview()
    if (pathRef.current.length >= 2) {
      pushStroke({ type: mode, ...styleFor(mode, color), points: pathRef.current })
    }
    pathRef.current = []
    lastRef.current = null
    liveIdRef.current = null
  }

  const clear = () => {
    const drawings = drawingsRef.current
    if (!drawings) return
    drawings.doc.transact(() => drawings.delete(0, drawings.length))
  }

  const toggle = (next) => setMode((m) => (m === next ? 'none' : next))

  return {
    canvasRef,
    mode,
    setMode,
    toggle,
    color,
    setColor,
    visible,
    setVisible: (v) => {
      if (v && mode !== 'none') setMode('none')
      setVisible(v)
    },
    clear,
    undo: () => undoRef.current?.undo(),
    redo: () => undoRef.current?.redo(),
    armed: mode !== 'none',
    count: strokes.length,
    handlers: {
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: stop,
      onPointerCancel: stop,
      onPointerLeave: stop,
    },
  }
}
