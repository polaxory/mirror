import React, { useMemo, useRef, useState } from 'react'
import { sol, when, isNum } from '../fmt.js'

// Realized cumulative PnL by exit. Single series, so the title names it and no
// legend box is needed. Hover gives a crosshair plus a tooltip; the drawdown span
// is shaded so the worst stretch is visible without a second axis.
export default function EquityCurve({ equity, maxDD }) {
  const wrap = useRef(null)
  const [hover, setHover] = useState(null)
  const W = 720
  const H = 190
  const PADL = 46
  const PADR = 12
  const PADT = 14
  const PADB = 26

  const geom = useMemo(() => {
    if (!equity || equity.length < 2) return null
    const xs = equity.map((e) => e.ts)
    const ys = equity.map((e) => e.cum)
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const yMinRaw = Math.min(0, ...ys)
    const yMaxRaw = Math.max(0, ...ys)
    const span = yMaxRaw - yMinRaw || 1
    const yMin = yMinRaw - span * 0.08
    const yMax = yMaxRaw + span * 0.08
    const sx = (t) => PADL + ((t - x0) / (x1 - x0 || 1)) * (W - PADL - PADR)
    const sy = (v) => PADT + (1 - (v - yMin) / (yMax - yMin)) * (H - PADT - PADB)
    const pts = equity.map((e) => [sx(e.ts), sy(e.cum)])
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
    const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${sy(0).toFixed(1)} L${pts[0][0].toFixed(1)},${sy(0).toFixed(1)} Z`

    // peak-to-trough span for shading
    let peak = -Infinity, peakI = 0, ddStart = 0, ddEnd = 0, worst = 0
    equity.forEach((e, i) => {
      if (e.cum > peak) { peak = e.cum; peakI = i }
      const d = peak - e.cum
      if (d > worst) { worst = d; ddStart = peakI; ddEnd = i }
    })

    // y ticks: zero plus min and max
    const ticks = [...new Set([0, yMinRaw, yMaxRaw].map((v) => +v.toFixed(2)))]
    return { sx, sy, pts, path, area, x0, x1, yMin, yMax, ticks, ddStart, ddEnd, worst }
  }, [equity])

  if (!geom) {
    return (
      <div className="panel">
        <div className="panel-h">Realized PnL over time</div>
        <div className="thin">Needs at least two closed trades to draw a curve.</div>
      </div>
    )
  }

  const onMove = (e) => {
    const rect = wrap.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = 0
    let bestD = Infinity
    geom.pts.forEach(([x], i) => {
      const d = Math.abs(x - px)
      if (d < bestD) { bestD = d; best = i }
    })
    setHover(best)
  }

  const hp = hover !== null ? geom.pts[hover] : null
  const hd = hover !== null ? equity[hover] : null
  const final = equity[equity.length - 1].cum

  return (
    <div className="panel">
      <div className="panel-h">
        Realized PnL over time
        <span className="panel-sub">
          ends at {sol(final)} SOL · worst drawdown {sol(geom.worst, { sign: false })} SOL
        </span>
      </div>
      <div
        className="chartwrap"
        ref={wrap}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img"
          aria-label={`Cumulative realized profit and loss across ${equity.length} closed trades, ending at ${sol(final)} SOL`}>
          {/* drawdown span */}
          {geom.worst > 0 && (
            <rect
              x={geom.pts[geom.ddStart][0]}
              y={PADT}
              width={Math.max(1, geom.pts[geom.ddEnd][0] - geom.pts[geom.ddStart][0])}
              height={H - PADT - PADB}
              className="dd-span"
            />
          )}
          {/* gridlines + y labels */}
          {geom.ticks.map((t) => (
            <g key={t}>
              <line x1={PADL} x2={W - PADR} y1={geom.sy(t)} y2={geom.sy(t)}
                className={t === 0 ? 'axis-zero' : 'grid'} />
              <text x={PADL - 8} y={geom.sy(t) + 3.5} className="tick" textAnchor="end">
                {t === 0 ? '0' : sol(t, { sign: false, dp: 0 })}
              </text>
            </g>
          ))}
          {/* x labels */}
          <text x={PADL} y={H - 8} className="tick">{when(geom.x0)}</text>
          <text x={W - PADR} y={H - 8} className="tick" textAnchor="end">{when(geom.x1)}</text>

          <path d={geom.area} className={final >= 0 ? 'eq-area up' : 'eq-area down'} />
          <path d={geom.path} className={final >= 0 ? 'eq-line up' : 'eq-line down'} />

          {hp && (
            <g>
              <line x1={hp[0]} x2={hp[0]} y1={PADT} y2={H - PADB} className="crosshair" />
              <circle cx={hp[0]} cy={hp[1]} r="4.5" className="eq-dot" />
            </g>
          )}
        </svg>
        {hd && (
          <div
            className="tip"
            style={{
              left: `${(hp[0] / W) * 100}%`,
              transform: hp[0] > W * 0.7 ? 'translate(-100%, -50%)' : 'translate(8px, -50%)',
              top: `${(hp[1] / H) * 100}%`,
            }}
          >
            <div className="tip-v">{sol(hd.cum)} SOL</div>
            <div className="tip-k">after trade {hover + 1} · {when(hd.ts)}</div>
          </div>
        )}
      </div>
      <div className="chart-note">Realized exits only. Open positions are listed separately and are not in this curve.</div>
    </div>
  )
}
